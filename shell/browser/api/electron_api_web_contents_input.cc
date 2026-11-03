// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license.
#include "shell/browser/api/electron_api_web_contents.h"

#include <algorithm>
#include <cmath>
#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/timer/timer.h"
#include "content/browser/renderer_host/render_widget_host_impl.h"  // nogncheck
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "gin/arguments.h"
#include "shell/browser/api/input_sequence.h"
#include "shell/common/api/electron_api_native_image.h"
#include "shell/common/gin_converters/gfx_converter.h"
#include "shell/common/gin_converters/value_converter.h"
#include "shell/common/gin_helper/dictionary.h"
#include "shell/common/gin_helper/error_thrower.h"
#include "shell/common/gin_helper/promise.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "third_party/blink/public/mojom/widget/platform_widget.mojom.h"
#if BUILDFLAG(IS_WIN)
#include "shell/browser/ui/virtual_cursor.h"
#endif

namespace electron::api {
v8::Local<v8::Promise> WebContents::SetVirtualCursorEnabled(
    gin::Arguments* args) {
  gin_helper::Promise<void> promise(args->isolate());
  auto handle = promise.GetHandle();
#if BUILDFLAG(IS_WIN)
  v8::Local<v8::Value> enabled_value;
  gin_helper::Dictionary options;
  if (!args->GetNext(&enabled_value) || !enabled_value->IsBoolean() ||
      (args->Length() > 1 && !args->GetNext(&options))) {
    promise.RejectWithErrorMessage("INVALID_VIRTUAL_CURSOR_OPTIONS");
    return handle;
  }
  const bool enabled = enabled_value.As<v8::Boolean>()->Value();
  if (IsOffScreen() || is_guest()) {
    promise.RejectWithErrorMessage("VIRTUAL_CURSOR_VIEW_UNSUPPORTED");
    return handle;
  }
  if (!virtual_cursor_)
    virtual_cursor_ = std::make_unique<VirtualCursor>(web_contents());
  const bool previous_enabled = virtual_cursor_->enabled();
  const bool previous_pointer = virtual_cursor_->block_pointer();
  const bool previous_keyboard = virtual_cursor_->block_keyboard();
  bool pointer = previous_pointer, keyboard = previous_keyboard;
  if (!options.IsEmpty() && ((options.Has("blockRealPointer") &&
                              !options.Get("blockRealPointer", &pointer)) ||
                             (options.Has("blockRealKeyboard") &&
                              !options.Get("blockRealKeyboard", &keyboard)))) {
    promise.RejectWithErrorMessage("INVALID_VIRTUAL_CURSOR_OPTIONS");
    return handle;
  }
  const auto error = virtual_cursor_->Configure(enabled, pointer, keyboard);
  if (!error.empty()) {
    promise.RejectWithErrorMessage(error);
    return handle;
  }
  const auto epoch = ++virtual_cursor_epoch_;
  struct Barrier {
    explicit Barrier(gin_helper::Promise<void> p) : promise(std::move(p)) {}
    gin_helper::Promise<void> promise;
    base::OneShotTimer timer;
    int remaining = 0;
    bool done = false;
  };
  auto barrier = std::make_shared<Barrier>(std::move(promise));
  std::vector<content::RenderWidgetHostImpl*> widgets;
  web_contents()->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
    auto* widget =
        content::RenderWidgetHostImpl::From(frame->GetRenderWidgetHost());
    if (frame->IsRenderFrameLive() &&
        std::ranges::find(widgets, widget) == widgets.end())
      widgets.push_back(widget);
  });
  barrier->remaining = widgets.size();
  if (widgets.empty()) {
    barrier->promise.Resolve();
    return handle;
  }
  barrier->timer.Start(
      FROM_HERE, base::Seconds(2),
      base::BindOnce(
          [](std::shared_ptr<Barrier> state, base::WeakPtr<WebContents> self,
             uint64_t epoch, bool e, bool p, bool k) {
            if (state->done)
              return;
            state->done = true;
            if (self && self->virtual_cursor_ &&
                self->virtual_cursor_epoch_ == epoch)
              self->virtual_cursor_->Configure(e, p, k);
            state->promise.RejectWithErrorMessage(
                "NATIVE_INPUT_BARRIER_TIMEOUT");
          },
          barrier, GetWeakPtr(), epoch, previous_enabled, previous_pointer,
          previous_keyboard));
  for (auto* widget : widgets) {
    // Ping is queued behind pending input in Blink's MainThreadEventQueue
    // (WidgetInputHandlerImpl::RunOnMainThread / QueueClosure). New OS input
    // has already been gated above; this does not wait for screen presentation.
    widget->GetWidgetInputHandler()->PingMainThread(base::BindOnce(
        [](std::shared_ptr<Barrier> state, base::WeakPtr<WebContents> self,
           uint64_t epoch) {
          if (state->done)
            return;
          if (--state->remaining == 0) {
            state->done = true;
            state->timer.Stop();
            if (!self || self->virtual_cursor_epoch_ != epoch)
              state->promise.RejectWithErrorMessage(
                  "VIRTUAL_CURSOR_CONFIGURATION_SUPERSEDED");
            else
              state->promise.Resolve();
          }
        },
        barrier, GetWeakPtr(), epoch));
  }
#else
  promise.RejectWithErrorMessage("VIRTUAL_CURSOR_PLATFORM_UNSUPPORTED");
#endif
  return handle;
}

void WebContents::SetVirtualCursorImage(gin::Arguments* args) {
#if BUILDFLAG(IS_WIN)
  v8::Local<v8::Value> value;
  gin_helper::Dictionary options;
  if (!args->GetNext(&value) ||
      (args->Length() > 1 && !args->GetNext(&options))) {
    args->ThrowTypeError("Expected NativeImage or null and optional options");
    return;
  }
  NativeImage* image = nullptr;
  if (!value->IsNull() &&
      (!gin::ConvertFromV8(args->isolate(), value, &image) || !image ||
       image->image().IsEmpty())) {
    args->ThrowTypeError(
        "Expected a nonempty NativeImage or null; paths and URLs are not "
        "accepted");
    return;
  }
  gfx::PointF hotspot;
  if (!options.IsEmpty() && options.Has("hotspot") &&
      !options.Get("hotspot", &hotspot)) {
    args->ThrowTypeError("Invalid hotspot");
    return;
  }
  if (!virtual_cursor_)
    virtual_cursor_ = std::make_unique<VirtualCursor>(web_contents());
  const auto error = virtual_cursor_->SetImage(
      image ? *image->image().ToImageSkia() : gfx::ImageSkia(), hotspot);
  if (!error.empty())
    gin_helper::ErrorThrower(args->isolate()).ThrowError(error);
#else
  gin_helper::ErrorThrower(args->isolate())
      .ThrowError("VIRTUAL_CURSOR_PLATFORM_UNSUPPORTED");
#endif
}

void WebContents::SetVirtualCursorFrameRate(gin::Arguments* args) {
  v8::Local<v8::Value> value;
  if (!args->GetNext(&value) || !value->IsInt32() ||
      value.As<v8::Int32>()->Value() < 0 ||
      value.As<v8::Int32>()->Value() > 1000) {
    gin_helper::ErrorThrower(args->isolate())
        .ThrowRangeError("Cursor frame rate must be an integer from 0 to 1000");
    return;
  }
#if BUILDFLAG(IS_WIN)
  const int fps = value.As<v8::Int32>()->Value();
  if (!virtual_cursor_)
    virtual_cursor_ = std::make_unique<VirtualCursor>(web_contents());
  virtual_cursor_->SetFrameRate(fps);
#else
  gin_helper::ErrorThrower(args->isolate())
      .ThrowError("VIRTUAL_CURSOR_PLATFORM_UNSUPPORTED");
#endif
}

base::DictValue WebContents::GetVirtualCursorState() {
#if BUILDFLAG(IS_WIN)
  if (virtual_cursor_)
    return virtual_cursor_->GetState();
#endif
  return base::DictValue().Set("enabled", false);
}

void WebContents::UpdateVirtualCursor(const blink::WebMouseEvent& event,
                                      content::RenderWidgetHostView* view) {
#if BUILDFLAG(IS_WIN)
  if (virtual_cursor_)
    virtual_cursor_->OnInjectedMouse(event, view);
#endif
}

bool WebContents::CanDragEnter(content::WebContents*,
                               const content::DropData&,
                               blink::DragOperationsMask) {
#if BUILDFLAG(IS_WIN)
  if (virtual_cursor_ && virtual_cursor_->block_pointer())
    return false;
#endif
  return true;
}

v8::Local<v8::Promise> WebContents::RunInputSequence(gin::Arguments* args) {
  base::ListValue steps;
  base::DictValue options;
  int id;
  gin_helper::Promise<base::DictValue> promise(args->isolate());
  auto handle = promise.GetHandle();
  if (!args->GetNext(&steps) || !args->GetNext(&options) ||
      !args->GetNext(&id) || id <= 0 || steps.empty() || steps.size() > 10000 ||
      input_sequence_id_) {
    promise.RejectWithErrorMessage("INVALID_OR_BUSY_INPUT_SEQUENCE");
    return handle;
  }
  for (const auto& step : steps) {
    if (!step.is_dict() || !step.GetDict().Find("atMs") ||
        !step.GetDict().FindString("kind") ||
        !step.GetDict().FindString("type")) {
      promise.RejectWithErrorMessage("INVALID_INPUT_STEP");
      return handle;
    }
  }
  input_sequence_ = std::make_unique<InputSequence>(
      this, id, std::move(steps), std::move(options), std::move(promise));
  input_sequence_->Start();
  return handle;
}

void WebContents::CancelInputSequence(int id) {
  if (input_sequence_ && input_sequence_id_ == id)
    input_sequence_->Cancel("ABORTED");
}
}  // namespace electron::api
