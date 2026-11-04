// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license.
#include "shell/browser/ui/virtual_cursor.h"

#include <algorithm>
#include <cmath>
#include <utility>

#include "base/functional/bind.h"
#include "content/browser/renderer_host/render_widget_host_impl.h"  // nogncheck
#include "content/browser/renderer_host/render_widget_host_view_aura.h"  // nogncheck
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "third_party/skia/include/core/SkCanvas.h"
#include "third_party/skia/include/core/SkPaint.h"
#include "third_party/skia/include/core/SkPathBuilder.h"
#include "ui/aura/client/drag_drop_client.h"
#include "ui/aura/window.h"
#include "ui/compositor/compositor.h"
#include "ui/compositor/layer.h"
#include "ui/compositor/paint_recorder.h"
#include "ui/events/event.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/geometry/transform.h"
#include "ui/gfx/image/image_skia_rep.h"

namespace electron {
namespace {
gfx::ImageSkia Arrow() {
  SkBitmap bitmap;
  bitmap.allocN32Pixels(24, 30);
  bitmap.eraseColor(SK_ColorTRANSPARENT);
  SkCanvas canvas(bitmap);
  SkPathBuilder path;
  path.moveTo(2, 2)
      .lineTo(2, 23)
      .lineTo(8, 18)
      .lineTo(12, 27)
      .lineTo(16, 25)
      .lineTo(12, 16)
      .lineTo(20, 16)
      .close();
  const auto arrow = path.detach();
  SkPaint paint;
  paint.setAntiAlias(true);
  paint.setColor(SK_ColorWHITE);
  canvas.drawPath(arrow, paint);
  paint.setColor(SK_ColorBLACK);
  paint.setStyle(SkPaint::kStroke_Style);
  paint.setStrokeWidth(1.5f);
  canvas.drawPath(arrow, paint);
  bitmap.setImmutable();
  return gfx::ImageSkia::CreateFrom1xBitmap(bitmap);
}
}  // namespace

VirtualCursor::VirtualCursor(content::WebContents* contents)
    : content::WebContentsObserver(contents), image_(Arrow()) {}

VirtualCursor::~VirtualCursor() {
  ReleaseWidgets();
  Detach();
}

std::string VirtualCursor::ValidateConfiguration(bool display,
                                                 bool pointer,
                                                 bool keyboard,
                                                 bool isolate) const {
  if (display || pointer || keyboard || isolate) {
    auto* native = web_contents() ? web_contents()->GetNativeView() : nullptr;
    if (!native || !web_contents()->GetRenderWidgetHostView())
      return "VIRTUAL_CURSOR_VIEW_UNAVAILABLE";
    auto* root = native->GetRootWindow();
    auto* drag = root ? aura::client::GetDragDropClient(root) : nullptr;
    if (pointer && drag && drag->IsDragDropInProgress())
      return "NATIVE_DRAG_IN_PROGRESS";
    // Existing native compositions cannot be made invisible retroactively.
    auto* view = static_cast<content::RenderWidgetHostViewAura*>(
        web_contents()->GetRenderWidgetHostView());
    if (keyboard && view->HasCompositionText())
      return "NATIVE_COMPOSITION_IN_PROGRESS";
  }
  return {};
}

std::string VirtualCursor::Configure(bool display,
                                     bool pointer,
                                     bool keyboard,
                                     bool isolate) {
  const auto error = ValidateConfiguration(display, pointer, keyboard, isolate);
  if (!error.empty())
    return error;
  RestoreConfiguration(display, pointer, keyboard, isolate);
  return {};
}

void VirtualCursor::RestoreConfiguration(bool display,
                                         bool pointer,
                                         bool keyboard,
                                         bool isolate) {
  enabled_ = display;
  block_pointer_ = pointer;
  block_keyboard_ = keyboard;
  isolate_input_ = isolate;
  if (!Active()) {
    ReleaseWidgets();
    Detach();
    return;
  }
  BindView();
  dirty_ = true;
  Schedule();
}

std::string VirtualCursor::SnapshotImage(const gfx::ImageSkia& image,
                                         gfx::PointF hotspot,
                                         gfx::ImageSkia* result) {
  gfx::ImageSkia replacement = image.isNull() ? Arrow() : image;
  if (replacement.width() < 1 || replacement.height() < 1 ||
      replacement.width() > 512 || replacement.height() > 512 ||
      !std::isfinite(hotspot.x()) || !std::isfinite(hotspot.y()) ||
      hotspot.x() < 0 || hotspot.y() < 0 ||
      hotspot.x() >= replacement.width() || hotspot.y() >= replacement.height())
    return "INVALID_CURSOR_IMAGE_OR_HOTSPOT";
  const SkBitmap& source = replacement.GetRepresentation(1.f).GetBitmap();
  SkBitmap snapshot;
  if (!snapshot.tryAllocPixels(source.info()) ||
      !source.readPixels(snapshot.pixmap(), 0, 0))
    return "CURSOR_IMAGE_SNAPSHOT_FAILED";
  snapshot.setImmutable();
  *result = gfx::ImageSkia::CreateFrom1xBitmap(snapshot);
  return {};
}

void VirtualCursor::RestoreImage(const gfx::ImageSkia& snapshot,
                                 gfx::PointF hotspot) {
  image_ = snapshot;
  hotspot_ = hotspot;
  image_dirty_ = true;
  dirty_ = true;
  Schedule();
}

std::string VirtualCursor::SetImage(const gfx::ImageSkia& image,
                                    gfx::PointF hotspot) {
  gfx::ImageSkia snapshot;
  const auto error = SnapshotImage(image, hotspot, &snapshot);
  if (!error.empty())
    return error;
  RestoreImage(snapshot, hotspot);
  return {};
}

void VirtualCursor::SetFrameRate(int fps) {
  fps_ = fps;
  StopFrame();
  Schedule();
}

void VirtualCursor::BindView() {
  if (!Active() || !web_contents())
    return;
  // Isolation must also be released/restored while the root view is absent
  // during a swap. Visual layers can bind when a native view becomes ready.
  BindWidgets();
  auto* native = web_contents()->GetNativeView();
  if (native != window_) {
    Detach();
    window_ = native;
    if (!window_)
      return;
    window_->AddObserver(this);
  }
  if (!window_)
    return;
  if (enabled_ && !clip_) {
    clip_ = ui::Layer::Create(ui::LAYER_NOT_DRAWN);
    clip_->SetName("ElectronVirtualCursorClip");
    clip_->SetMasksToBounds(true);
    clip_->SetAcceptEvents(false);
    window_->layer()->Add(clip_.get());
    sprite_ = ui::Layer::Create(ui::LAYER_TEXTURED);
    sprite_->SetName("ElectronVirtualCursor");
    sprite_->SetFillsBoundsOpaquely(false);
    sprite_->SetAcceptEvents(false);
    sprite_->set_delegate(this);
    clip_->Add(sprite_.get());
    image_dirty_ = true;
  }
  if (!enabled_) {
    StopFrame();
    sprite_.reset();
    clip_.reset();
  }
  auto* root = window_->GetRootWindow();
  if (root != event_root_) {
    if (event_root_)
      event_root_->RemovePreTargetHandler(this);
    event_root_ = root;
    if (event_root_)
      event_root_->AddPreTargetHandler(this,
                                       ui::EventTarget::Priority::kSystem);
  }
  if (clip_) {
    clip_->SetBounds(gfx::Rect(window_->bounds().size()));
    window_->layer()->StackAtTop(clip_.get());
  }
  dirty_ = true;
  Schedule();
}

bool VirtualCursor::Active() const {
  return enabled_ || block_pointer_ || block_keyboard_ || isolate_input_;
}

void VirtualCursor::BindWidgets() {
  if (!web_contents())
    return;
  std::vector<content::RenderWidgetHostImpl*> current;
  web_contents()->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
    // Do not bring prerendered or BFCache documents into the virtual channel.
    if (content::WebContents::FromRenderFrameHost(frame) != web_contents() ||
        frame->GetLifecycleState() !=
            content::RenderFrameHost::LifecycleState::kActive ||
        !frame->IsRenderFrameLive()) {
      return;
    }
    auto* widget =
        content::RenderWidgetHostImpl::From(frame->GetRenderWidgetHost());
    if (std::ranges::find(current, widget) == current.end())
      current.push_back(widget);
  });
  std::erase_if(isolated_widgets_, [&](const auto& widget) {
    if (!widget)
      return true;
    if (isolate_input_ &&
        std::ranges::find(current, widget.get()) != current.end()) {
      return false;
    }
    widget->SetInputIsolationEnabled(false);
    return true;
  });
  if (isolate_input_) {
    for (auto* widget : current) {
      widget->SetInputIsolationEnabled(true);
      if (!std::ranges::any_of(isolated_widgets_,
                               [widget](const auto& tracked) {
                                 return tracked.get() == widget;
                               })) {
        isolated_widgets_.push_back(widget->GetWeakPtr());
      }
    }
  }

  // Native keyboard/IME input enters through the root Aura view even when an
  // out-of-process child frame owns the renderer's current element focus.
  auto* view = static_cast<content::RenderWidgetHostViewAura*>(
      web_contents()->GetRenderWidgetHostView());
  std::erase_if(filtered_views_, [view](const auto& filtered) {
    if (!filtered)
      return true;
    if (filtered.get() == view)
      return false;
    static_cast<content::RenderWidgetHostViewAura*>(filtered.get())
        ->SetNativeInputFilter({});
    return true;
  });
  if (view) {
    view->SetNativeInputFilter(base::BindRepeating(
        [](base::WeakPtr<VirtualCursor> self, bool keyboard) {
          return self && self->FilterNative(keyboard);
        },
        weak_factory_.GetWeakPtr()));
    if (filtered_views_.empty())
      filtered_views_.push_back(view->GetWeakPtr());
  }
}

void VirtualCursor::ReleaseWidgets() {
  for (const auto& widget : isolated_widgets_) {
    if (widget)
      widget->SetInputIsolationEnabled(false);
  }
  isolated_widgets_.clear();
  for (const auto& view : filtered_views_) {
    if (view) {
      static_cast<content::RenderWidgetHostViewAura*>(view.get())
          ->SetNativeInputFilter({});
    }
  }
  filtered_views_.clear();
}

void VirtualCursor::Detach() {
  StopFrame();
  if (event_root_)
    event_root_->RemovePreTargetHandler(this);
  event_root_ = nullptr;
  sprite_.reset();
  clip_.reset();
  if (window_)
    window_->RemoveObserver(this);
  window_ = nullptr;
}

bool VirtualCursor::Visible() const {
  return enabled_ && window_ && window_->IsVisible() && web_contents() &&
         web_contents()->GetVisibility() == content::Visibility::VISIBLE &&
         window_->layer()->GetCompositor();
}

void VirtualCursor::StopFrame() {
  timer_.Stop();
  if (observing_)
    observing_->RemoveAnimationObserver(this);
  observing_ = nullptr;
}

void VirtualCursor::Schedule() {
  if (!dirty_ || !Visible() || timer_.IsRunning() || observing_)
    return;
  const float refresh = window_->layer()->GetCompositor()->refresh_rate();
  const double rate = fps_ ? std::min<double>(fps_, refresh) : refresh;
  const auto wait = last_draw_ + base::Seconds(1.0 / std::max(1.0, rate)) -
                    base::TimeTicks::Now();
  if (wait.is_positive()) {
    timer_.Start(FROM_HERE, wait, this, &VirtualCursor::RequestFrame);
  } else {
    RequestFrame();
  }
}

void VirtualCursor::RequestFrame() {
  if (!Visible() || !dirty_ || observing_)
    return;
  observing_ = window_->layer()->GetCompositor();
  observing_->AddAnimationObserver(this);
}

void VirtualCursor::OnAnimationStep(base::TimeTicks timestamp) {
  StopFrame();
  if (!Visible() || !sprite_)
    return;
  if (image_dirty_) {
    sprite_->SetBounds(gfx::Rect(image_.size()));
    sprite_->SchedulePaint(gfx::Rect(image_.size()));
    image_dirty_ = false;
  }
  gfx::Transform transform;
  transform.Translate(position_.x() - hotspot_.x(),
                      position_.y() - hotspot_.y());
  sprite_->SetTransform(transform);
  sprite_->SetOpacity(buttons_ ? 0.65f : 1.f);
  clip_->SetVisible(true);
  // Use the compositor's frame clock. Callback delivery can occur after the
  // frame timestamp; using wall time here would miss the next refresh when
  // the requested rate equals the display rate.
  last_draw_ = timestamp;
  dirty_ = false;
  ++draws_;
}

void VirtualCursor::OnCompositingShuttingDown(ui::Compositor* compositor) {
  StopFrame();
}

void VirtualCursor::OnInjectedMouse(const blink::WebMouseEvent& event,
                                    content::RenderWidgetHostView* view) {
  if (!Active() || !view || !web_contents())
    return;
  auto* root_view = web_contents()->GetRenderWidgetHostView();
  if (!root_view)
    return;
  gfx::PointF point = event.PositionInWidget();
  static_cast<content::RenderWidgetHostViewBase*>(view)
      ->TransformPointToCoordSpaceForView(
          point, static_cast<content::RenderWidgetHostViewBase*>(root_view),
          &point);
  position_ = point;
  buttons_ = event.GetModifiers() & (blink::WebInputEvent::kLeftButtonDown |
                                     blink::WebInputEvent::kRightButtonDown |
                                     blink::WebInputEvent::kMiddleButtonDown |
                                     blink::WebInputEvent::kBackButtonDown |
                                     blink::WebInputEvent::kForwardButtonDown);
  dirty_ = true;
  Schedule();
}

bool VirtualCursor::FilterNative(bool keyboard) {
  const bool blocked = keyboard ? block_keyboard() : block_pointer();
  if (blocked)
    ++(keyboard ? blocked_keyboard_ : blocked_pointer_);
  return blocked;
}

void VirtualCursor::OnEvent(ui::Event* event) {
  if (!window_ || !event->target())
    return;
  auto* target = static_cast<aura::Window*>(event->target());
  if (!window_->Contains(target))
    return;
  const bool keyboard = event->IsKeyEvent();
  const bool pointer = event->IsMouseEvent() || event->IsScrollEvent() ||
                       event->IsTouchEvent() || event->IsGestureEvent();
  if ((keyboard || pointer) && FilterNative(keyboard)) {
    event->SetHandled();
    event->StopPropagation();
  }
}

void VirtualCursor::OnPaintLayer(const ui::PaintContext& context) {
  ui::PaintRecorder recorder(context, image_.size());
  recorder.canvas()->DrawImageInt(image_, 0, 0);
  ++paints_;
}

void VirtualCursor::OnDeviceScaleFactorChanged(float, float) {
  image_dirty_ = true;
  dirty_ = true;
  Schedule();
}
void VirtualCursor::OnWindowBoundsChanged(aura::Window*,
                                          const gfx::Rect&,
                                          const gfx::Rect&,
                                          ui::PropertyChangeReason) {
  BindView();
}
void VirtualCursor::OnWindowVisibilityChanged(aura::Window*, bool) {
  if (!Visible()) {
    StopFrame();
  } else {
    dirty_ = true;
    Schedule();
  }
}
void VirtualCursor::OnWindowHierarchyChanged(const HierarchyChangeParams&) {
  BindView();
}
void VirtualCursor::OnWindowRemovingFromRootWindow(aura::Window*,
                                                   aura::Window*) {
  StopFrame();
  if (event_root_)
    event_root_->RemovePreTargetHandler(this);
  event_root_ = nullptr;
}
void VirtualCursor::OnWindowAddedToRootWindow(aura::Window*) {
  BindView();
}
void VirtualCursor::OnVisibilityChanged(content::Visibility visibility) {
  if (visibility != content::Visibility::VISIBLE) {
    StopFrame();
  } else {
    dirty_ = true;
    Schedule();
  }
}
void VirtualCursor::OnWindowDestroying(aura::Window*) {
  Detach();
}
void VirtualCursor::RenderViewReady() {
  BindView();
}
void VirtualCursor::RenderFrameCreated(content::RenderFrameHost*) {
  BindView();
}
void VirtualCursor::RenderViewHostChanged(content::RenderViewHost*,
                                          content::RenderViewHost*) {
  BindView();
}
void VirtualCursor::RenderFrameHostChanged(content::RenderFrameHost*,
                                           content::RenderFrameHost*) {
  BindView();
}
void VirtualCursor::RenderFrameHostStateChanged(
    content::RenderFrameHost*,
    content::RenderFrameHost::LifecycleState,
    content::RenderFrameHost::LifecycleState) {
  if (Active())
    BindWidgets();
}
void VirtualCursor::WebContentsDestroyed() {
  enabled_ = false;
  block_pointer_ = false;
  block_keyboard_ = false;
  isolate_input_ = false;
  ReleaseWidgets();
  Detach();
}

base::DictValue VirtualCursor::GetState() const {
  return base::DictValue()
      .Set("enabled", enabled_)
      .Set("blockRealPointer", block_pointer())
      .Set("blockRealKeyboard", block_keyboard())
      .Set("isolateInput", isolate_input())
      .Set("frameRate", fps_)
      .Set("refreshRate",
           window_ && window_->layer()->GetCompositor()
               ? window_->layer()->GetCompositor()->refresh_rate()
               : 0)
      .Set("x", position_.x())
      .Set("y", position_.y())
      .Set("buttons", buttons_)
      .Set("draws", draws_)
      .Set("paints", paints_)
      .Set("visible", Visible())
      .Set("pending", timer_.IsRunning() || observing_ != nullptr)
      .Set("compositorVisible",
           window_ && window_->layer()->GetCompositor() &&
               window_->layer()->GetCompositor()->IsVisible())
      .Set("nativeViewVisible", window_ && window_->IsVisible())
      .Set("nativeParentVisible",
           window_ && window_->parent() && window_->parent()->IsVisible())
      .Set("layerVisible", window_ && window_->layer()->visible())
      .Set("rootLayerVisible", window_ && window_->GetRootWindow() &&
                                   window_->GetRootWindow()->layer()->visible())
      .Set("renderWidgetHidden",
           web_contents() && web_contents()->GetPrimaryMainFrame() &&
               content::RenderWidgetHostImpl::From(
                   web_contents()->GetPrimaryMainFrame()->GetRenderWidgetHost())
                   ->IsHidden())
      .Set("blockedPointer", blocked_pointer_)
      .Set("blockedKeyboard", blocked_keyboard_);
}
}  // namespace electron
