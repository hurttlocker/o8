# Custom canvas background evidence

The Chromium fixture renders the production Canvas appearance tuner and backdrop
layer, plus a sample reading card using the shared Canvas glass material. The
four screenshots cover light and dark appearances over bright and dark images at
900 by 700. Tests also check horizontal fit at 1680 by 1050 and at least 4.5:1
contrast for the reading text over the image and its scrim.

- [Light, bright image](./light-bright.png)
- [Light, dark image](./light-dark.png)
- [Dark, bright image](./dark-bright.png)
- [Dark, dark image](./dark-dark.png)

Reproduce from the repository root with Chromium available:

```sh
O8_CAPTURE_BACKGROUND_EVIDENCE=1 npm run test:integration -- tests/canvas-custom-background-real-path.test.ts
```

The test selects an actual file through the production input, verifies that no
network requests occur during import, closes and reopens the browser context
with persisted local storage, and removes the image after reopening. Photo,
ASCII and dither use the same local raster. Validation and storage failures keep
the saved image intact. This is source and browser evidence; an installed native
application restart was not exercised.
