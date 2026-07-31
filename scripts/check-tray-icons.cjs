const { createHash } = require("node:crypto");
const { app } = require("electron");

app.whenReady().then(() => {
  const {
    createTrayMenuIcon,
    trayIconKinds
  } = require("../dist-electron/tray-icons.js");
  const diagnostics = trayIconKinds.map((kind) => {
    const image = createTrayMenuIcon(kind);
    const png = image.toPNG();
    const bitmap = image.toBitmap();
    let visiblePixels = 0;
    for (let index = 3; index < bitmap.length; index += 4) {
      if (bitmap[index] > 0) visiblePixels += 1;
    }
    return {
      kind,
      empty: image.isEmpty(),
      width: image.getSize().width,
      height: image.getSize().height,
      visiblePixels,
      hash: createHash("sha256").update(png).digest("hex")
    };
  });
  const unique = new Set(diagnostics.map((item) => item.hash));
  const invalid = diagnostics.filter(
    (item) =>
      item.empty ||
      item.width !== 16 ||
      item.height !== 16 ||
      item.visiblePixels < 8
  );
  if (invalid.length > 0 || unique.size !== diagnostics.length) {
    process.exitCode = 1;
    console.error(
      JSON.stringify(
        {
          ok: false,
          unique: unique.size,
          total: diagnostics.length,
          invalid
        },
        null,
        2
      )
    );
  } else {
    console.log(
      JSON.stringify(
        {
          ok: true,
          unique: unique.size,
          total: diagnostics.length
        },
        null,
        2
      )
    );
  }
  app.quit();
});
