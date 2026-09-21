# Isolated image fixtures

Generated locally with sharp 0.35.4 from a six-pixel RGB buffer; no user images or downloaded assets. `two-by-three.*` are 2×3 pixels, `rotated.jpg` has EXIF orientation 6 (displayed 3×2), and `animated.webp` has two distinct 1×1 frames (red then green, 100 ms each). Tests verify literal dimensions and frame counts, not generator output as an oracle. GIF fixtures are short, fixed bytes embedded in the test and do not require a decoder in the test setup.

`viewer-large.png` is a fixed 1600×1200 RGB checkerboard and border generated locally with Pillow. It exercises fit/100% and scrolling without invoking Electron nativeImage during test setup. No user images are used.
