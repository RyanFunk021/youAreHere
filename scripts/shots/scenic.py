# A synthetic "hike photo" (no real place) with EXIF GPS, for the help screenshots.
# Usage: python3 scenic.py OUT.jpg LAT LNG     (needs Pillow)
import random, sys
from PIL import Image, ImageDraw, ImageFilter
out, lat, lng = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
W, H = 1200, 900
img = Image.new('RGB', (W, H)); d = ImageDraw.Draw(img)
for y in range(H // 2 + 60):
    t = y / (H / 2 + 60); d.line([(0, y), (W, y)], fill=(int(120 + 100 * t), int(170 + 60 * t), int(230 - 10 * t)))
d.polygon([(0, 520), (200, 380), (420, 470), (640, 330), (900, 450), (1200, 360), (1200, 900), (0, 900)], fill=(92, 120, 96))
d.polygon([(0, 640), (300, 540), (600, 610), (900, 520), (1200, 600), (1200, 900), (0, 900)], fill=(58, 96, 52))
random.seed(4)
for _ in range(60):
    x = random.randint(0, W); y = random.randint(600, 860); h = random.randint(50, 120)
    d.polygon([(x, y - h), (x - h // 3, y), (x + h // 3, y)], fill=(30, random.randint(60, 85), 35))
d.polygon([(520, 900), (600, 700), (640, 700), (760, 900)], fill=(150, 120, 80))
img = img.filter(ImageFilter.SMOOTH)
def dms(v):
    v = abs(v); dd = int(v); m = int((v - dd) * 60); return (float(dd), float(m), round(((v - dd) * 60 - m) * 60, 4))
ex = Image.Exif(); g = ex.get_ifd(0x8825)
g[1] = 'N' if lat >= 0 else 'S'; g[2] = dms(lat); g[3] = 'E' if lng >= 0 else 'W'; g[4] = dms(lng)
img.save(out, quality=88, exif=ex.tobytes())
