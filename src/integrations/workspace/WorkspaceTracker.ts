import * as vscode from "vscode"
import * as path from "path"
import { listFiles, getDirsToIgnore } from "../../services/glob/list-files"
import { ClineProvider } from "../../core/webview/ClineProvider"
import micromatch from "micromatch"
import { GitIgnoreProcessor } from "../../services/glob/git-ignore"

const cwd = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0)

namespace WorkspaceTracker {
	export type QueueFunction = () => Promise<void> | void
}

// Note: this is not a drop-in replacement for listFiles at the start of tasks, since that will be done for Desktops when there is no workspace selected
class WorkspaceTracker {
	private static readonly DEBOUNCE_DELAY = 1000 // debounce period in milliseconds for messages to the WebView-UI
	private static readonly EVENT_FLOOD_SZ = 100 // number of events - the underlying watcher can be overwhelmed by fast bulk changes like rm -rf

	private providerRef: WeakRef<ClineProvider>
	private disposables: vscode.Disposable[] = []
	private filePaths: Set<string> = new Set()

	// queue to ensure in order handling of filesystem notifications (stat in 'addFilePath' is async)
	private notifyQueue: Promise<void> = Promise.resolve()

	private workspaceDidUpdateTimeout: NodeJS.Timeout | null = null // event debounce timer
	private gitIgnoreProcessor: GitIgnoreProcessor
	private eventCount: number = 0

	// needReInit triggers a call to initializeFilePaths to reanalyze the workspace
	// Several things trigger needReInit:
	//   - Directory ‘move’ operations. They do not send notifications for each child.
	//   - Changes to .gitignore
	//   - Event floods that overwhelm the inotify system, like rm -rf on a large dir
	//   - TODO: changes to the contextExclude config globs ( getDirsToIgnore() )
	private needReInit: boolean = false // triggers a call to initializeFilePaths

	constructor(provider: ClineProvider) {
		this.providerRef = new WeakRef(provider)
		this.gitIgnoreProcessor = new GitIgnoreProcessor(cwd || process.cwd())
		this.registerFileSystemWatcher()
	}

	async initializeFilePaths() {
		let paths = new Set<string>()
		// should not auto get filepaths for desktop since it would immediately show permission popup before cline ever creates a file
		if (!cwd) {
			return
		}

		const maxContextFiles = 1_000 // TODO: get from configuration?

		this.filePaths.clear()
		const [files, _] = await listFiles(cwd, true, maxContextFiles)
		files.forEach((file) => paths.add(this.normalizeFilePath(file)))
		this.filePaths = paths

		this.needReInit = false

		this.workspaceDidUpdate()
	}

	private registerFileSystemWatcher() {
		if (!cwd) {
			return
		}

		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(cwd, "**/*"))
		const configGlobsToIgnore = getDirsToIgnore()

		// Watch for file creation
		watcher.onDidCreate((uri) => {
			this.addEventToNotifyQueue(async () => {
				// Perform flood detection first, as even unmonitored file events can cause state loss during a flood.
				this.incrementEventAndDetectFlood()
				if (this.shouldIgnoreGlob(uri.fsPath, configGlobsToIgnore)) {
					return // Ignore this event
				}
				await this.addFilePath(uri.fsPath)
				this.triggerWorkspaceDidUpdate()
			})
		})

		// Watch for file deletion
		watcher.onDidDelete((uri) => {
			this.addEventToNotifyQueue(async () => {
				// Perform flood detection first, as even unmonitored file events can cause state loss during a flood.
				this.incrementEventAndDetectFlood()
				if (this.shouldIgnoreGlob(uri.fsPath, configGlobsToIgnore)) {
					return
				}
				if (this.removeFilePath(uri.fsPath)) {
					this.triggerWorkspaceDidUpdate()
				}
			})
		})

		// Watch for file changes
		watcher.onDidChange((uri) => {
			this.addEventToNotifyQueue(async () => {
				this.incrementEventAndDetectFlood()
				if (this.shouldIgnoreGlob(uri.fsPath, configGlobsToIgnore)) {
					return
				}
				this.removeFilePath(uri.fsPath)
				await this.addFilePath(uri.fsPath)
				this.triggerWorkspaceDidUpdate()
			})
		})

		this.disposables.push(watcher)
	}

	addEventToNotifyQueue(task: () => Promise<void>): void {
		// Chain events received in order and trigger updates to the webview if successful
		this.notifyQueue = this.notifyQueue
			.then(() => task()) // Execute the task
			.catch((err) => {})
	}

	private shouldIgnoreGlob(filePath: string, exclusionGlobs: string[]): boolean {
		// First check .gitignore rules
		if (this.gitIgnoreProcessor.shouldIgnoreFile(filePath, [])) {
			return true // File is ignored by .gitignore
		}

		// Use micromatch to check against exclusion globs
		const isMatch = micromatch.isMatch(filePath, exclusionGlobs, { dot: true })
		return isMatch // Return true if filePath matches exclusion globs
	}

	private triggerWorkspaceDidUpdate() {
		// Debounced trigger for workspaceDidUpdate, in case a lot of stuff is happening on the fs
		// e.g. rm -rf of a large directory
		if (this.workspaceDidUpdateTimeout) {
			clearTimeout(this.workspaceDidUpdateTimeout)
		}

		// Set timeout to delay execution of workspaceDidUpdate
		this.workspaceDidUpdateTimeout = setTimeout(() => {
			// a directory move or a flood occurred, e.g. rm -rf of a big directory and likely some notifications
			// have been lost, reinit our file state
			if (this.needReInit) {
				this.addEventToNotifyQueue(async () => {
					this.initializeFilePaths()
				})
			} else {
				this.workspaceDidUpdate()
			}
			this.eventCount = 0
		}, WorkspaceTracker.DEBOUNCE_DELAY) // 1 second debounce
	}

	private workspaceDidUpdate() {
		if (!cwd) {
			return
		}

		const maxContextFiles = 1_000 // TODO: get from configuration???

		this.providerRef.deref()?.postMessageToWebview({
			type: "workspaceUpdated",
			filePaths: Array.from(this.filePaths)
				.slice(0, maxContextFiles)
				.map((file) => {
					const relativePath = path.relative(cwd, file).toPosix()
					return file.endsWith("/") ? relativePath + "/" : relativePath
				}),
		})
	}

	private normalizeFilePath(filePath: string): string {
		const resolvedPath = cwd ? path.resolve(cwd, filePath) : path.resolve(filePath)
		return filePath.endsWith("/") ? resolvedPath + "/" : resolvedPath
	}

	private async addFilePath(filePath: string): Promise<string> {
		const normalizedPath = this.normalizeFilePath(filePath)
		try {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.file(normalizedPath))
			const isDirectory = (stat.type & vscode.FileType.Directory) !== 0
			const pathWithSlash = isDirectory && !normalizedPath.endsWith("/") ? normalizedPath + "/" : normalizedPath

			if (isDirectory) {
				this.needReInit = true
			}

			// Check if any .gitignore file in the workspace was modified
			if (path.basename(normalizedPath) === ".gitignore") {
				this.gitIgnoreProcessor.clearCache()
				this.needReInit = true
			}

			this.filePaths.add(pathWithSlash)
			return pathWithSlash
		} catch {
			// If stat fails, assume it's a file (this can happen for newly created files)
			this.filePaths.add(normalizedPath)
			return normalizedPath
		}
	}

	private removeFilePath(filePath: string): boolean {
		const normalizedPath = this.normalizeFilePath(filePath)
		let isFile = this.filePaths.delete(normalizedPath)

		if (!isFile) {
			this.needReInit = true
		}

		// Check if any .gitignore file in the workspace was deleted
		if (path.basename(normalizedPath) === ".gitignore") {
			this.gitIgnoreProcessor.clearCache()
			this.needReInit = true
		}

		// if the file delete did not succeed, try the dir delete
		return isFile || this.filePaths.delete(normalizedPath + "/")
	}

	private incrementEventAndDetectFlood(): void {
		if (this.eventCount++ > WorkspaceTracker.EVENT_FLOOD_SZ) {
			this.needReInit = true
		}
	}

	public dispose() {
		this.disposables.forEach((d) => d.dispose())
	}
}

export default WorkspaceTracker
