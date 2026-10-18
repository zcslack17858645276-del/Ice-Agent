# Phase 1.1 Development Log: Live2D Runtime Integration

## Date

2026-10-18

## Objective

Integrate the existing Live2D Cubism model into Ice Agent, render it in the desktop pet view, connect model animation and physics to the existing character controller, and keep the static avatar and application UI available as fallback. Follow-up work in this phase makes model discovery and resource paths work with the renamed and additional model assets already supplied to the repository.

## Starting State and Diagnosis

- Phase 1 provided the React/Tauri pet view, state machine, static PNG renderer, character settings, and local preference persistence.
- Live2D assets were present, but the runtime integration initially assumed `assets/live2d/seethrough_output_1.model3.json` and a fixed filename in the tests.
- The worktree's supplied models are located at `assets/xglk/seethrough_output_1.model3.json`, `assets/miku_free/runtime/miku.model3.json`, and `assets/miku_pro/runtime/miku_sample_t04.model3.json`.
- Each `.model3.json` describes the model binary, textures, physics, motions, and other resources using paths relative to that model configuration. Runtime SDK files and shader files are separate from model entries and must not be discovered as models.

## Implementation

### Cubism runtime and rendering

- Integrated the supplied official Cubism SDK for Web 5-r.5 Framework source through the existing Vite alias and a small project adapter. No SDK copy or unrelated rendering framework was added for this work.
- Added runtime loading for the supplied Cubism Core script and the WebGL shader assets. The framework is initialized once and the model is created through the character controller.
- Added the Live2D renderer and controller lifecycle: load model resources, initialize the provider, create the model handle, apply current state and expression, resize to the canvas, update and draw frames, and dispose resources and the animation frame loop on unmount.
- The Cubism adapter binds each configured texture, loads configured motion groups, applies configured expression files when available, evaluates configured physics during frame updates, and renders to an alpha-enabled WebGL canvas.
- Existing state mappings remain: IDLE/WORKING/SLEEPING use Idle, THINKING uses Nod, and HAPPY/SAD use Shake. Unknown state names use Idle.

### Model discovery, validation, and selection

- Added a Vite virtual catalog that scans only `*.model3.json` files under the designated `assets/xglk`, `assets/miku_free`, and `assets/miku_pro` directories. Runtime SDK files and arbitrary JSON files are excluded.
- Catalog entries use stable asset-relative paths as identifiers. The default remains the XGLK model when present; other discovered models can be selected in Settings, and the selected identifier persists with existing avatar preferences.
- Added validation of each entry's FileReferences. `Moc` and at least one texture are required. Configured resource references are resolved relative to the model entry directory and checked; failures are kept as explicit model errors for display in Settings.
- Physics, motions, and expressions are optional when omitted. When listed in the model configuration, their referenced resources must resolve and parse; configured-but-missing resources are not silently ignored.
- Replaced tests that expected the obsolete `assets/live2d` tree with discovery and loader tests using isolated fixture maps and the actual supplied models. Coverage includes renamed model entry files, nested relative resource paths, missing required files, optional sections, and configured physics, motions, and expressions.

### Avatar display modes and application behavior

- Kept Live2D as the default avatar display mode and retained the accessible Live2D / Static PNG selector in Settings.
- Static PNG mode uses the existing registered character image and does not mount or initialize the Live2D renderer. Switching models or modes creates the selected renderer lifecycle without changing the chat panel or window structure.
- Kept automatic static-avatar fallback for Live2D resource or initialization failures.
- The existing chat panel remains part of the application and is unaffected by model selection.

## Files and Boundaries

- `frontend/avatar/live2d/catalogCore.mjs`: pure model-entry discovery filter shared with the Vite plugin and tests.
- `vite.config.ts`: build-time catalog generation for the designated model directories.
- `frontend/avatar/live2d/catalog.ts`: stable model IDs, names, default selection, and runtime validation statuses.
- `frontend/avatar/live2d/model.ts`: state-to-motion mapping, resource URL resolution, and runtime asset paths.
- `frontend/avatar/live2d/runtime.ts`: model configuration parsing, resource validation/loading, and Cubism provider selection.
- `frontend/avatar/live2d/types.ts`: typed model resources and runtime contracts.
- `frontend/avatar/live2d/controller.ts`: model lifecycle and frame-loop control.
- `frontend/avatar/live2d/renderer.tsx`: canvas renderer lifecycle bound to React.
- `frontend/avatar/live2d/cubismAdapter.ts`: Cubism 5-r.5 model, texture, motion, expression, physics, and WebGL adapter.
- `frontend/App.tsx`: persisted model selection and independent Live2D / Static PNG selection.
- `frontend/avatar/stateMachine.test.mjs`: state, asset, discovery, and resource validation tests.
- `eslint.config.js`: excludes the vendored minified Cubism Core runtime from source linting.

## Verification Performed

Checks run after the final implementation changes:

```text
npm.cmd run test       # 10 tests passed, 0 failed
npm.cmd run typecheck  # passed
npm.cmd run lint       # passed
npm.cmd run build      # passed; production Vite bundle generated
Prettier on changed files  # passed
git diff --check       # passed (line-ending warnings only)
```

Additional runtime checks:

- The production build was served with Vite Preview and loaded in headless Microsoft Edge.
- HTTP requests for all three discovered model entry files returned 200.
- HTTP requests for a nested Miku motion and Miku model binary returned 200.
- The built UI rendered the avatar area and Live2D canvas in its default Live2D mode, alongside the existing static image during model startup.
- Tests validated that Static PNG selection is a separate renderer path by asserting the application implementation keeps Live2D rendering conditional; no dedicated automated click-through harness is installed in the project.

## Results and Remaining Limits

- The former test failures came from hardcoded expectations for files under `assets/live2d`, not from invalid model resources. Tests now validate discovered entries and their configured references, and all three supplied models validate.
- Model entry filenames can change without source changes as long as the entry remains within a designated model directory. Resource filenames and nested paths are obtained from each model's FileReferences.
- Automated verification confirms resource loading and production UI startup. It does not establish visual motion playback, the rendered physics effect, or Tauri-specific transparent-window composition. Those still require a desktop WebView session with a usable GPU/WebGL context.
- The Miku models are discoverable and their resources validate, but their visual rendering and state-to-motion mapping have not been manually assessed. Current state mappings are the existing XGLK mappings and fall back to the Idle motion group when the selected model does not define a mapped group.
- The application model catalog is intentionally limited to `assets/xglk`, `assets/miku_free`, and `assets/miku_pro`; adding another top-level model directory requires adding that directory to the Vite catalog's designated-directory list.

## Phase Result

The existing Cubism 5-r.5 integration now discovers and validates the supplied custom models, loads resources through each model's own relative configuration, and offers persistent model selection alongside the independent Live2D / Static PNG setting. Required automated checks pass. Desktop visual verification of motions, physics, and transparent-window behavior remains outstanding.
