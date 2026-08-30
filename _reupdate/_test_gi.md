# .gitignore
- L1: node_modules/ — Excludes the Node.js dependency directory; standard practice to keep third-party packages out of version control.
- L2: out/ — Excludes a build output directory (e.g., TypeScript `tsc` default output); generated artifacts are typically not committed.
- L3: dist/ — Excludes the distribution/build output directory; commonly produced by bundlers like Webpack or Rollup.
- L4: *.vsix — Excludes Visual Studio Code extension package files; binary artifacts generated during packaging.
- L5: openclaw/ — Excludes the openclaw directory (likely project-specific generated or vendor content).
- L6: npm-debug.log — Excludes the npm debug log file produced after failed npm operations.
- L7: CleanVeb.log — Excludes a project-specific clean/VEB log file generated during build or cleanup runs.
