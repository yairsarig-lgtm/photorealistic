"""Cut several cast shadows out of one wall photo.

Usage: python3 extract_shadows.py photo.png out_dir name1 name2 ...
Names are given in reading order (top row left to right, then the next row).

The bare wall is estimated with a smooth surface fitted to the lit pixels;
dividing by it turns the wall pure white and leaves only each shadow's
darkening, as a neutral grey layer for multiply blending. Parts of one symbol
that are close together (e.g. three wavy lines) are kept as one.
"""
import sys, os
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

src, out_dir, names = sys.argv[1], sys.argv[2], sys.argv[3:]
os.makedirs(out_dir, exist_ok=True)
a = np.asarray(Image.open(src).convert("RGB")).astype(np.float64) / 255.0
lum = a @ np.array([0.2126, 0.7152, 0.0722])
H, W = lum.shape

# 1. Bare-wall estimate from the brightest pixels (iterate: fit, drop shadows, refit).
yy, xx = np.mgrid[0:H, 0:W]
u, v = xx / W, yy / H
X = np.stack([np.ones_like(u), u, v, u * u, v * v, u * v, u ** 3, v ** 3], -1)
lit = lum > np.percentile(lum, 50)
for _ in range(3):
    coef, *_ = np.linalg.lstsq(X[lit][::5], lum[lit][::5], rcond=None)
    bg = X @ coef
    lit = lum > bg * 0.95
ratio = np.clip(lum / np.maximum(bg, 1e-3), 0, 1)

# 2. Clean the bare wall to pure white, keep texture inside the shadows (softened).
smooth = np.asarray(Image.fromarray((ratio * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(np.float64) / 255
inside = np.clip((0.93 - smooth) / 0.08, 0, 1)
soft = np.asarray(Image.fromarray((ratio * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))).astype(np.float64) / 255
ratio = 0.4 * ratio + 0.6 * soft
ratio = 1 - (1 - ratio) * inside
ratio = np.where(ratio > 0.985, 1.0, ratio)

# 3. Find each symbol: shadow pixels, grown so nearby parts merge into one.
mask = smooth < 0.9
grown = ndimage.binary_dilation(mask, iterations=max(6, int(min(H, W) * 0.035)))
labels, n = ndimage.label(grown)
boxes = []
for i, sl in enumerate(ndimage.find_objects(labels), 1):
    part = mask[sl] & (labels[sl] == i)
    if part.sum() < H * W * 0.004:   # ignore specks
        continue
    ys, xs = np.where(part)
    boxes.append((ys.min() + sl[0].start, ys.max() + sl[0].start, xs.min() + sl[1].start, xs.max() + sl[1].start))

# Reading order: group into rows by vertical centre, then left to right.
boxes.sort(key=lambda b: (b[0] + b[1]) / 2)
rows, row_h = [], max(b[1] - b[0] for b in boxes)
for b in boxes:
    cy = (b[0] + b[1]) / 2
    if rows and abs(cy - rows[-1][0]) < row_h * 0.6:
        rows[-1][1].append(b)
    else:
        rows.append([cy, [b]])
ordered = [b for _, r in rows for b in sorted(r, key=lambda b: b[2])]
print(f"found {len(ordered)} symbols")
if len(ordered) != len(names):
    sys.exit(f"expected {len(names)} symbols, found {len(ordered)}")

# 4. Crop each into a square, symbol spanning ~84%, feathered to white at the border.
for name, (y0, y1, x0, x1) in zip(names, ordered):
    cy, cx = (y0 + y1) / 2, (x0 + x1) / 2
    half = max(y1 - y0, x1 - x0) / 2 / 0.84
    size = int(half * 2)
    canvas = np.ones((size, size))
    oy, ox = int(cy - half), int(cx - half)
    sy0, sx0, sy1, sx1 = max(0, oy), max(0, ox), min(H, oy + size), min(W, ox + size)
    canvas[sy0 - oy:sy1 - oy, sx0 - ox:sx1 - ox] = ratio[sy0:sy1, sx0:sx1]
    # Keep only this symbol (blank out neighbours that fall inside the square).
    own = np.zeros((size, size), bool)
    lab = labels[sy0:sy1, sx0:sx1]
    mid = labels[int(cy), int(cx)] or np.bincount(lab[mask[sy0:sy1, sx0:sx1]]).argmax()
    own[sy0 - oy:sy1 - oy, sx0 - ox:sx1 - ox] = lab == mid
    own = ndimage.binary_dilation(own, iterations=4)
    canvas = np.where(own, canvas, 1.0)
    edge = max(2, int(size * 0.04))
    ramp = np.ones(size); ramp[:edge] = np.linspace(0, 1, edge); ramp[-edge:] = np.linspace(1, 0, edge)
    canvas = 1 - (1 - canvas) * np.minimum.outer(ramp, ramp)
    img = Image.fromarray((canvas * 255).round().astype(np.uint8), "L").resize((1024, 1024), Image.LANCZOS)
    img.save(os.path.join(out_dir, name + ".png"), optimize=True)
    print("saved", name, f"{x1 - x0}x{y1 - y0}px source", "darkest", round(float(canvas.min()), 2))
