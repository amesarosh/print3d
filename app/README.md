# Print3D Studio

Print3D Studio is a desktop application for designing 3D-printable parts with Claude. It provides a project browser, an interactive 3D viewer, a script editor and a chat panel for the build123d projects in this repository.

The application is built with Electron, React and the Claude Agent SDK, and is packaged for Debian-based Linux distributions (amd64).

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Chat settings](#chat-settings)
- [Development](#development)
- [Architecture](#architecture)

## Features

- **Project browser.** Lists the projects in the repository's `projects/` folder and creates new ones.
- **Part versions.** Exports named `<part>`, `<part>_v2`, `<part>_v3` and so on are grouped as versions of one part, with a version switcher.
- **3D viewer.** Displays each exported part as an interactive model.
- **Script editor.** Opens a part's Python script with syntax highlighting, save, revert and detection of changes made on disk.
- **Integrated chat.** Runs Claude Code in the repository root, so it follows `CLAUDE.md`, writes and runs scripts, and reviews the rendered previews.
- **Live refresh.** Views update automatically when project files change.
- **Slicer hand-off.** Opens a part's 3MF file in Bambu Studio.

## Requirements

| Component | Purpose |
| --- | --- |
| Debian-based Linux, amd64 | Target platform of the `.deb` package |
| Node.js and npm | Building the application |
| [uv](https://docs.astral.sh/uv/) | Running part scripts |
| Bambu Studio (Flatpak, `com.bambulab.BambuStudio`) | Opening sliced 3MF files |
| A Claude login or `ANTHROPIC_API_KEY` | Chat |

## Installation

Build the package and install it:

```sh
cd app
npm install
npm run dist
sudo apt install ./release/print3d-studio_<version>_amd64.deb
```

After `npm install` has been run once, `install.sh` in the repository root performs the build and installation in a single step.

The package installs to `/opt/Print3D Studio` with an AppArmor profile, which allows Chromium's sandbox to run. It bundles its own Claude Code binary and authenticates in the same way as the `claude` CLI: with your existing login or with `ANTHROPIC_API_KEY`.

| Task | Command |
| --- | --- |
| Update | Rebuild, then run `apt install` again (or run `install.sh`) |
| Uninstall | `sudo apt remove print3d-studio` |

## Usage

Start **Print3D Studio** from the application menu. On first launch it asks for the repository folder, which is the one that contains `projects/`. Use **Change…** at the bottom of the sidebar to select a different folder later.

The window has three panels:

| Panel | Contents |
| --- | --- |
| Left | The project list. **New** creates a project folder. **Nozzle** sets the nozzle fitted to the printer; parts are sliced for it the next time their script runs. |
| Middle | The selected project's parts. Switch between the 3D model and the **Script** view. **Run** saves any edits and runs the script with `uv run`. **Open in Bambu Studio** opens the part's 3MF file. |
| Right | The chat with Claude about the project. Chats are saved per project and resume where they ended. |

In the script editor, **Save** (or Ctrl+S) writes your changes and **Revert** discards them.

Images that are pasted, dropped or attached in the chat are saved to the project's `ref/` folder. Claude receives a scaled copy (up to 1568 px) together with the saved path.

## Chat settings

| Setting | Behaviour |
| --- | --- |
| Model | The list of available models comes from your account. |
| Effort | A change takes effect with your next message. The session restarts and resumes the same chat. |
| Permissions | See below. |

Permission modes:

| Mode | Behaviour |
| --- | --- |
| Ask before edits | Prompts with Allow, Always allow or Deny for each file edit and command. |
| Auto-accept edits | Applies file edits without asking, and still asks before running commands. |
| Auto | Lets Claude Code's classifier decide. |
| Plan only | Makes no changes. |

## Development

Build and run from source:

```sh
npm start
```

| Script | Description |
| --- | --- |
| `npm start` | Builds the application and runs it from source |
| `npm run build` | Bundles the main process, preload script and renderer into `dist/` |
| `npm run typecheck` | Type-checks the sources without emitting output |
| `npm run dist` | Builds the `.deb` package into `release/` |

`npm start` passes `--no-sandbox`, because Ubuntu's AppArmor configuration blocks Chromium's sandbox for applications run from a home folder. The installed package does not need this flag.

The repository folder is resolved in this order:

1. The `PRINT3D_ROOT` environment variable.
2. The folder saved from a previous selection.
3. In development, the folder that contains `app/`.
4. A folder chosen in a dialog.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/main/main.ts` | The window, IPC handlers and the `proj://` protocol that serves project files to the UI |
| `src/main/agent.ts` | One Agent SDK session per project, with a streaming prompt, permission prompts and the saved session list |
| `src/main/projects.ts` | Project scanning, the file watcher, and launching scripts and Bambu Studio |
| `src/main/memlog.ts` | Logs the application's memory use every minute to `~/.config/print3d-studio/memory.log` |
| `src/preload.ts` | Exposes a narrow, typed API to the renderer as `window.studio` |
| `src/shared/api.ts` | Types of the preload API |
| `src/shared/parts.ts` | Part and version naming rules used by both processes |
| `src/renderer/index.tsx` | The React UI entry point |
| `src/renderer/Chat.tsx` | The chat panel |
| `src/renderer/ScriptEditor.tsx` | The script editor, built on CodeMirror |
| `src/renderer/StlViewer.tsx` | The 3D viewer, built on three.js |
| `src/renderer/studio.ts` | The renderer's access to the preload API, with helpers |
| `build.mjs` | The esbuild configuration |
