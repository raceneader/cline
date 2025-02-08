import ignore from "ignore"
import micromatch from "micromatch"
import fs from "fs"
import path from "path"

export class GitIgnoreProcessor {
	private gitignoreCache: Map<string, ignore.Ignore> = new Map()

	constructor(private workspacePath: string) {}

	/**
	 * Clears the gitignore rules cache, forcing rules to be reloaded on next check.
	 * Call this when .gitignore files have been modified.
	 */
	public clearCache(): void {
		this.gitignoreCache.clear()
	}

	/**
	 * Checks if a file should be ignored based on .gitignore rules and additional exclusion globs.
	 * @param filePath Absolute file path to check.
	 * @param exclusionGlobs Additional glob patterns for exclusion.
	 * @returns {boolean} Whether the file should be ignored.
	 */
	public shouldIgnoreFile(filePath: string, exclusionGlobs: string[]): boolean {
		const fileDir = path.dirname(filePath)
		const gitignoreRules = this.getGitignoreRulesForPath(fileDir)

		// Apply .gitignore rules if found
		if (gitignoreRules.ignores(path.relative(fileDir, filePath))) {
			return true // File is ignored by a .gitignore rule
		}

		// Use micromatch for additional exclusion globs
		return micromatch.isMatch(filePath, exclusionGlobs, { dot: true })
	}

	/**
	 * Finds and caches .gitignore rules for a given directory, stopping at the workspace root.
	 * @param dir Directory path to check.
	 * @returns {ignore.Ignore} An ignore instance with all applicable .gitignore rules.
	 */
	private getGitignoreRulesForPath(dir: string): ignore.Ignore {
		if (this.gitignoreCache.has(dir)) {
			return this.gitignoreCache.get(dir)!
		}

		const gitignoreInstance = ignore()
		let currentDir = dir

		// Walk up directory tree to collect .gitignore rules, stopping at workspace root
		while (currentDir.startsWith(this.workspacePath) && currentDir !== path.parse(currentDir).root) {
			const gitignorePath = path.join(currentDir, ".gitignore")

			if (fs.existsSync(gitignorePath)) {
				try {
					const content = fs.readFileSync(gitignorePath, "utf8")
					gitignoreInstance.add(content)
				} catch (err) {
					console.error(`Error reading .gitignore at ${gitignorePath}:`, err)
				}
			}

			// Stop at workspace root
			if (currentDir === this.workspacePath) {
				break
			}

			// Move up one level
			currentDir = path.dirname(currentDir)
		}

		this.gitignoreCache.set(dir, gitignoreInstance) // Cache result
		return gitignoreInstance
	}
}
