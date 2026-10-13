# Contributing to DeepGPU Zoomer

Bug reports, focused improvements, documentation corrections and performance investigations are welcome.

## Before contributing

- Read the [README](README.md) for browser requirements, controls and architecture.
- Search existing issues and pull requests to avoid duplicates. For substantial changes, open an issue first to discuss the motivation and scope.
- Keep changes narrow and explain the concrete problem they solve. Avoid unrelated refactoring.
- Respect the project's [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

Use **Node.js 24 and npm**, matching the GitHub workflows. The pinned Vite version supports Node.js 20.19+ on the 20.x line, or 22.12+ on newer lines; see [Vite's setup requirements](https://vite.dev/guide/).

```sh
npm ci
npm run dev
npm test
npm run build
```

The development server binds to `127.0.0.1:5183` by default. The build includes TypeScript checking. Rendering requires a supported WebGPU browser, GPU and driver; automated tests do not replace checking visual behavior in a browser.

## Issues and pull requests

For a bug, include steps to reproduce, expected and actual behavior, browser/OS/GPU information, and—when relevant—zoom depth, iteration limit and settings. For performance regressions, include a reproducible view and comparable before/after measurements.

For a pull request, describe why the change is necessary, its user-visible effects, how you tested it, and any known limitations. Do not claim support for hardware or browsers you have not tested. Avoid committing large generated outputs or personal saved-location exports.

DeepGPU Zoomer uses browser-local saved locations. **Before releasing a new candidate, changing an origin/port, or replacing a live version, preserve and verify the user's saved locations** as required by [AGENTS.md](AGENTS.md). A normal pull request need not export another person's browser data.

By contributing, you agree that your contributions are licensed under the project's [GPL-3.0-or-later](LICENSE), consistent with applicable third-party notices in [NOTICE.md](NOTICE.md).
