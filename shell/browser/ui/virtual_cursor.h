// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license.
#ifndef ELECTRON_SHELL_BROWSER_UI_VIRTUAL_CURSOR_H_
#define ELECTRON_SHELL_BROWSER_UI_VIRTUAL_CURSOR_H_

#include <memory>
#include <string>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/aura/window_observer.h"
#include "ui/compositor/compositor_animation_observer.h"
#include "ui/compositor/layer_delegate.h"
#include "ui/events/event_handler.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/image/image_skia.h"

namespace aura {
class Window;
}
namespace ui {
class Layer;
}
namespace blink {
class WebMouseEvent;
}
namespace electron {

// Browser UI layers, never part of the renderer's captured Surface.
class VirtualCursor final : public content::WebContentsObserver,
                            public aura::WindowObserver,
                            public ui::LayerDelegate,
                            public ui::CompositorAnimationObserver,
                            public ui::EventHandler {
 public:
  explicit VirtualCursor(content::WebContents* contents);
  ~VirtualCursor() override;
  std::string Configure(bool enabled, bool pointer, bool keyboard);
  std::string SetImage(const gfx::ImageSkia& image, gfx::PointF hotspot);
  void SetFrameRate(int fps);
  void OnInjectedMouse(const blink::WebMouseEvent& event,
                       content::RenderWidgetHostView* view);
  bool enabled() const { return enabled_; }
  bool block_pointer() const { return enabled_ && block_pointer_; }
  bool block_keyboard() const { return enabled_ && block_keyboard_; }
  base::DictValue GetState() const;

 private:
  void BindView();
  void Detach();
  void Schedule();
  void RequestFrame();
  void StopFrame();
  bool Visible() const;
  bool FilterNative(bool keyboard);
  void OnEvent(ui::Event* event) override;
  void OnAnimationStep(base::TimeTicks timestamp) override;
  void OnCompositingShuttingDown(ui::Compositor* compositor) override;
  void OnPaintLayer(const ui::PaintContext& context) override;
  void OnDeviceScaleFactorChanged(float old_scale, float new_scale) override;
  void OnWindowBoundsChanged(aura::Window*,
                             const gfx::Rect&,
                             const gfx::Rect&,
                             ui::PropertyChangeReason) override;
  void OnWindowVisibilityChanged(aura::Window*, bool) override;
  void OnWindowHierarchyChanged(const HierarchyChangeParams&) override;
  void OnWindowRemovingFromRootWindow(aura::Window*, aura::Window*) override;
  void OnWindowAddedToRootWindow(aura::Window*) override;
  void OnWindowDestroying(aura::Window*) override;
  void RenderViewReady() override;
  void RenderViewHostChanged(content::RenderViewHost*,
                             content::RenderViewHost*) override;
  void RenderFrameHostChanged(content::RenderFrameHost*,
                              content::RenderFrameHost*) override;
  void WebContentsDestroyed() override;
  void OnVisibilityChanged(content::Visibility) override;
  raw_ptr<aura::Window> window_ = nullptr;
  raw_ptr<aura::Window> event_root_ = nullptr;
  raw_ptr<ui::Compositor> observing_ = nullptr;
  std::unique_ptr<ui::Layer> clip_;
  std::unique_ptr<ui::Layer> sprite_;
  gfx::ImageSkia image_;
  gfx::PointF hotspot_;
  gfx::PointF position_;
  bool enabled_ = false;
  bool block_pointer_ = false;
  bool block_keyboard_ = false;
  bool dirty_ = false;
  bool image_dirty_ = true;
  int fps_ = 0;
  int buttons_ = 0;
  int draws_ = 0;
  int paints_ = 0;
  int blocked_pointer_ = 0;
  int blocked_keyboard_ = 0;
  base::TimeTicks last_draw_;
  base::OneShotTimer timer_;
  base::WeakPtrFactory<VirtualCursor> weak_factory_{this};
};
}  // namespace electron
#endif
