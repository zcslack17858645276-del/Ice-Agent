# Ice Agent Live2D runtime assets

`live2dcubismcore.min.js` is Cubism Core for Web from the official Cubism SDK for Web 5-r.5 distribution. `shaders/WebGL/` contains the Framework WebGL shaders required by Cubism's renderer. The Framework TypeScript sources remain in `CubismSdkForWeb/` and are bundled by Vite through the `@cubism` alias; the original SDK checkout is preserved.

The project adapter is `frontend/avatar/live2d/cubismAdapter.ts`. Core, Framework, and this adapter run locally; the application does not fetch runtime code remotely. Core and Framework license notices are retained alongside the redistributed runtime assets. Review the applicable Live2D agreements before redistribution or commercial use.
