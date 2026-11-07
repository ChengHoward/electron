# Copyright (c) 2026 Electron Customizations.
# Use of this source code is governed by the MIT license.
"""Capture only the fixture interior, verify it is visible, and check host-mask ink loss."""
import ctypes,json,sys,time
from ctypes import wintypes
from pathlib import Path
from PIL import ImageGrab,Image
u=ctypes.windll.user32
u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
hwnd=wintypes.HWND(int(sys.argv[1]));image_path=Path(sys.argv[2]);renderer_path=Path(sys.argv[3]);scale=u.GetDpiForWindow(hwnd)/96
pt=wintypes.POINT(0,0);u.ClientToScreen(hwnd,ctypes.byref(pt))
# The fixture view starts at DIP (40,40), size (600,480). Capture only an
# interior margin around it, so no other application's pixels are retained.
bounds=(pt.x+round(30*scale),pt.y+round(30*scale),pt.x+round(650*scale),pt.y+round(530*scale))
image=None
for _ in range(25):
 trial=ImageGrab.grab(bbox=bounds,all_screens=True).convert('RGB')
 points=[(3,trial.height//2),(trial.width-4,trial.height//2),(trial.width//2,3),(trial.width//2,trial.height-4)]
 if all(trial.getpixel(p)==(255,0,255) for p in points):image=trial;break
 time.sleep(.2)
if image is None:raise RuntimeError('Fixture obscured or coordinate mismatch; no capture saved: '+json.dumps({'bounds':bounds,'origin':[pt.x,pt.y],'scale':scale,'marginPixels':[trial.getpixel(p) for p in points]}))
image.save(image_path)
render=Image.open(renderer_path).convert('RGB');ox=pt.x+round(40*scale)-bounds[0];oy=pt.y+round(40*scale)-bounds[1]
clipped=0;ink=0
for y in range(render.height):
 for x in range(render.width):
  if x<render.width-round(15*scale) and y<render.height-round(15*scale):continue
  r,g,b=render.getpixel((x,y))
  if max(r,g,b)<248 and max(r,g,b)-min(r,g,b)<8:
   ink+=1;nr,ng,nb=image.getpixel((ox+x,oy+y))
   if nr-ng>8 and nb-ng>8:clipped+=1
report={'nativeFixtureImage':str(image_path),'rendererImage':str(renderer_path),'scale':scale,'inkPixels':ink,'inkPixelsOutsideHostMask':clipped,'nativeCaptureBounds':bounds,'inkThreshold':248,'cutoutColorDifference':8}
image_path.with_suffix('.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
if clipped:sys.exit(1)
