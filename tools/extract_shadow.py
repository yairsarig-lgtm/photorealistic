# Pull a cast shadow off its wall: divide the photo by an estimate of the
# bare, lit wall, so the wall becomes pure white and only the shadow's
# darkening remains (as a neutral grey "density" map for multiply blending).
import sys, numpy as np
from PIL import Image, ImageFilter
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
a = np.asarray(im).astype(np.float64) / 255.0
lum = a @ np.array([0.2126, 0.7152, 0.0722])
H, W = lum.shape
# Lit wall = brighter pixels. Fit a smooth 2nd-order surface to them.
thr = np.percentile(lum, 70)
lit = lum > thr - 0.02
yy, xx = np.mgrid[0:H, 0:W]
X = np.stack([np.ones_like(xx), xx / W, yy / H, (xx / W) ** 2, (yy / H) ** 2, (xx / W) * (yy / H)], -1)
A = X[lit][::7]; b = lum[lit][::7]
coef, *_ = np.linalg.lstsq(A, b, rcond=None)
bg = X @ coef
ratio = np.clip(lum / np.maximum(bg, 1e-3), 0, 1)
# Remove the wall's own fine texture outside the shadow (keep it inside).
smooth = np.asarray(Image.fromarray((ratio * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(np.float64) / 255
shadow_mask = np.clip((0.93 - smooth) / 0.08, 0, 1)        # 0 = bare wall, 1 = in shadow
ratio = 1 - (1 - ratio) * shadow_mask
ratio = np.where(ratio > 0.985, 1.0, ratio)
# Crop square around the shadow with margin, so the shape spans ~84%.
ys, xs = np.where(ratio < 0.9)
cy, cx = (ys.min() + ys.max()) / 2, (xs.min() + xs.max()) / 2
half = max(ys.max() - ys.min(), xs.max() - xs.min()) / 2 / 0.84
canvas = np.ones((int(half * 2), int(half * 2)))
y0, x0 = int(cy - half), int(cx - half)
for (dy, dx) in [(0, 0)]:
    sy0, sx0 = max(0, y0), max(0, x0)
    sy1, sx1 = min(H, y0 + canvas.shape[0]), min(W, x0 + canvas.shape[1])
    canvas[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = ratio[sy0:sy1, sx0:sx1]
# Feather the outer border to pure white.
n = canvas.shape[0]; edge = int(n * 0.04)
ramp = np.ones(n); ramp[:edge] = np.linspace(0, 1, edge); ramp[-edge:] = np.linspace(1, 0, edge)
f = np.minimum.outer(ramp, ramp)
canvas = 1 - (1 - canvas) * f
img = Image.fromarray((canvas * 255).round().astype(np.uint8), "L").resize((1024, 1024), Image.LANCZOS)
img.save(out, optimize=True)
print("saved", out, "darkest", round(float(canvas.min()), 2))
