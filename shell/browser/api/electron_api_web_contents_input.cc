// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license.
#include "shell/browser/api/electron_api_web_contents.h"

#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <memory>
#include <string_view>
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
namespace {
#if BUILDFLAG(IS_WIN)
bool OnlyAutomationKeys(const gin_helper::Dictionary& value,
                        std::initializer_list<std::string_view> allowed) {
  auto* isolate = value.isolate();
  v8::Local<v8::Array> keys;
  if (!value.GetHandle()
           ->GetOwnPropertyNames(isolate->GetCurrentContext())
           .ToLocal(&keys))
    return false;
  for (uint32_t i = 0; i < keys->Length(); ++i) {
    v8::Local<v8::Value> key;
    std::string name;
    if (!keys->Get(isolate->GetCurrentContext(), i).ToLocal(&key) ||
        !gin::ConvertFromV8(isolate, key, &name) ||
        std::ranges::find(allowed, name) == allowed.end())
      return false;
  }
  return true;
}

bool HasAutomationValue(const gin_helper::Dictionary& dict, const char* key) {
  v8::Local<v8::Value> value;
  return dict.Get(key, &value) && !value->IsUndefined();
}

void AutomationInputBarrier(content::WebContents* contents,
                            gin_helper::Promise<void> promise,
                            base::RepeatingCallback<bool()> current,
                            base::OnceClosure rollback) {
  struct Barrier {
    explicit Barrier(gin_helper::Promise<void> p) : promise(std::move(p)) {}
    gin_helper::Promise<void> promise;
    base::OneShotTimer timer;
    base::RepeatingCallback<bool()> current;
    base::OnceClosure rollback;
    size_t remaining = 0;
    bool done = false;
  };
  auto state = std::make_shared<Barrier>(std::move(promise));
  state->current = std::move(current);
  state->rollback = std::move(rollback);
  std::vector<content::RenderWidgetHostImpl*> widgets;
  contents->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
    auto* widget =
        content::RenderWidgetHostImpl::From(frame->GetRenderWidgetHost());
    if (frame->IsRenderFrameLive() &&
        std::ranges::find(widgets, widget) == widgets.end())
      widgets.push_back(widget);
  });
  state->remaining = widgets.size();
  if (widgets.empty()) {
    state->promise.Resolve();
    return;
  }
  state->timer.Start(FROM_HERE, base::Seconds(2),
                     base::BindOnce(
                         [](std::shared_ptr<Barrier> state) {
                           if (state->done)
                             return;
                           state->done = true;
                           const bool current = state->current.Run();
                           if (current && state->rollback)
                             std::move(state->rollback).Run();
                           state->promise.RejectWithErrorMessage(
                               current ? "NATIVE_INPUT_BARRIER_TIMEOUT"
                                       : "AUTOMATION_CONFIGURATION_SUPERSEDED");
                         },
                         state));
  for (auto* widget : widgets) {
    widget->GetWidgetInputHandler()->PingMainThread(base::BindOnce(
        [](std::shared_ptr<Barrier> state) {
          if (state->done || --state->remaining != 0)
            return;
          state->done = true;
          state->timer.Stop();
          if (!state->current.Run())
            state->promise.RejectWithErrorMessage(
                "AUTOMATION_CONFIGURATION_SUPERSEDED");
          else
            state->promise.Resolve();
        },
        state));
  }
}
#endif
}  // namespace

v8::Local<v8::Promise> WebContents::SetAutomationOptions(gin::Arguments* args) {
  gin_helper::Promise<void> promise(args->isolate());
  auto handle = promise.GetHandle();
#if BUILDFLAG(IS_WIN)
  gin_helper::Dictionary options;
  if (!args->GetNext(&options) || args->Length() != 1 ||
      !OnlyAutomationKeys(
          options, {"isolateInput", "blockRealPointer", "blockRealKeyboard",
                    "keepRendering", "virtualCursor"})) {
    promise.RejectWithErrorMessage("INVALID_AUTOMATION_OPTIONS");
    return handle;
  }
  if (IsOffScreen() || is_guest()) {
    promise.RejectWithErrorMessage("AUTOMATION_VIEW_UNSUPPORTED");
    return handle;
  }
  if (!virtual_cursor_)
    virtual_cursor_ = std::make_unique<VirtualCursor>(web_contents());
  const bool old_display = virtual_cursor_->enabled();
  const bool old_pointer = virtual_cursor_->block_pointer();
  const bool old_keyboard = virtual_cursor_->block_keyboard();
  const bool old_isolate = virtual_cursor_->isolate_input();
  const bool old_keep = automation_keep_rendering_;
  const bool old_custom = automation_cursor_custom_image_;
  const auto old_image = virtual_cursor_->image();
  const auto old_hotspot = virtual_cursor_->hotspot();
  const auto old_fps = virtual_cursor_->frame_rate();
  bool display = old_display, pointer = old_pointer, keyboard = old_keyboard;
  bool isolate = old_isolate, keep = old_keep, custom = old_custom;
  auto image = old_image;
  auto hotspot = old_hotspot;
  int fps = old_fps;
  const auto read_bool = [](const gin_helper::Dictionary& dict, const char* key,
                            bool* value) {
    return !HasAutomationValue(dict, key) || dict.Get(key, value);
  };
  if (!read_bool(options, "blockRealPointer", &pointer) ||
      !read_bool(options, "blockRealKeyboard", &keyboard) ||
      !read_bool(options, "isolateInput", &isolate) ||
      !read_bool(options, "keepRendering", &keep)) {
    promise.RejectWithErrorMessage("INVALID_AUTOMATION_OPTIONS");
    return handle;
  }
  if (HasAutomationValue(options, "virtualCursor")) {
    gin_helper::Dictionary cursor;
    if (!options.Get("virtualCursor", &cursor) ||
        !OnlyAutomationKeys(cursor,
                            {"enabled", "image", "hotspot", "frameRate"}) ||
        !read_bool(cursor, "enabled", &display)) {
      promise.RejectWithErrorMessage("INVALID_AUTOMATION_CURSOR_OPTIONS");
      return handle;
    }
    if (HasAutomationValue(cursor, "image")) {
      v8::Local<v8::Value> value;
      NativeImage* native = nullptr;
      if (!cursor.Get("image", &value) ||
          (!value->IsNull() &&
           (!gin::ConvertFromV8(args->isolate(), value, &native) || !native ||
            native->image().IsEmpty()))) {
        promise.RejectWithErrorMessage("INVALID_AUTOMATION_CURSOR_IMAGE");
        return handle;
      }
      custom = !value->IsNull();
      image = native ? *native->image().ToImageSkia() : gfx::ImageSkia();
      hotspot = gfx::PointF();
    }
    if (HasAutomationValue(cursor, "hotspot") &&
        !cursor.Get("hotspot", &hotspot)) {
      promise.RejectWithErrorMessage("INVALID_AUTOMATION_CURSOR_HOTSPOT");
      return handle;
    }
    if (HasAutomationValue(cursor, "image") ||
        HasAutomationValue(cursor, "hotspot")) {
      gfx::ImageSkia snapshot;
      const auto error =
          VirtualCursor::SnapshotImage(image, hotspot, &snapshot);
      if (!error.empty()) {
        promise.RejectWithErrorMessage(error);
        return handle;
      }
      image = std::move(snapshot);
    }
    if (HasAutomationValue(cursor, "frameRate")) {
      v8::Local<v8::Value> value;
      if (!cursor.Get("frameRate", &value) || !value->IsInt32() ||
          !gin::ConvertFromV8(args->isolate(), value, &fps) || fps < 0 ||
          fps > 1000) {
        promise.RejectWithErrorMessage("INVALID_AUTOMATION_CURSOR_FRAME_RATE");
        return handle;
      }
    }
  }
  if ((input_sequence_id_ || automation_agent_input_active_) &&
      (pointer != old_pointer || keyboard != old_keyboard ||
       isolate != old_isolate)) {
    promise.RejectWithErrorMessage("AUTOMATION_INPUT_BUSY");
    return handle;
  }
  const auto error = virtual_cursor_->ValidateConfiguration(display, pointer,
                                                            keyboard, isolate);
  if (!error.empty() ||
      (keep &&
       (!web_contents() || !web_contents()->GetRenderWidgetHostView()))) {
    promise.RejectWithErrorMessage(error.empty() ? "AUTOMATION_VIEW_UNAVAILABLE"
                                                 : error);
    return handle;
  }
  virtual_cursor_->RestoreImage(image, hotspot);
  virtual_cursor_->SetFrameRate(fps);
  virtual_cursor_->Configure(display, pointer, keyboard, isolate);
  automation_keep_rendering_ = keep;
  automation_cursor_custom_image_ = custom;
  UpdateAutomationRendering();
  const auto epoch = ++virtual_cursor_epoch_;
  const auto image_epoch = automation_cursor_image_epoch_;
  const auto fps_epoch = automation_cursor_frame_rate_epoch_;
  auto current = base::BindRepeating(
      [](base::WeakPtr<WebContents> self, uint64_t epoch) {
        return self && self->virtual_cursor_epoch_ == epoch;
      },
      GetWeakPtr(), epoch);
  auto rollback = base::BindOnce(
      [](base::WeakPtr<WebContents> self, bool display, bool pointer,
         bool keyboard, bool isolate, bool keep, bool custom,
         gfx::ImageSkia image, gfx::PointF hotspot, int fps,
         uint64_t image_epoch, uint64_t fps_epoch) {
        if (!self || !self->virtual_cursor_)
          return;
        if (self->automation_cursor_image_epoch_ == image_epoch) {
          self->virtual_cursor_->RestoreImage(image, hotspot);
          self->automation_cursor_custom_image_ = custom;
        }
        if (self->automation_cursor_frame_rate_epoch_ == fps_epoch)
          self->virtual_cursor_->SetFrameRate(fps);
        self->virtual_cursor_->RestoreConfiguration(display, pointer, keyboard,
                                                    isolate);
        self->automation_keep_rendering_ = keep;
        self->UpdateAutomationRendering();
      },
      GetWeakPtr(), old_display, old_pointer, old_keyboard, old_isolate,
      old_keep, old_custom, old_image, old_hotspot, old_fps, image_epoch,
      fps_epoch);
  AutomationInputBarrier(web_contents(), std::move(promise), std::move(current),
                         std::move(rollback));
#else
  promise.RejectWithErrorMessage("AUTOMATION_PLATFORM_UNSUPPORTED");
#endif
  return handle;
}

base::DictValue WebContents::GetAutomationState() {
  auto cursor = GetVirtualCursorState();
  if (!cursor.contains("frameRate"))
    cursor.Set("frameRate", 0);
  bool pointer = false, keyboard = false, isolate = false, custom = false;
  gfx::PointF hotspot;
#if BUILDFLAG(IS_WIN)
  if (virtual_cursor_) {
    pointer = virtual_cursor_->block_pointer();
    keyboard = virtual_cursor_->block_keyboard();
    isolate = virtual_cursor_->isolate_input();
    hotspot = virtual_cursor_->hotspot();
    custom = automation_cursor_custom_image_;
  }
#endif
  cursor.Set("hotspot",
             base::DictValue().Set("x", hotspot.x()).Set("y", hotspot.y()));
  cursor.Set("customImage", custom);
  const bool available =
      web_contents() && web_contents()->GetRenderWidgetHostView() &&
      web_contents()->GetPrimaryMainFrame() &&
      web_contents()->GetPrimaryMainFrame()->IsRenderFrameLive();
  return base::DictValue()
      .Set("isolateInput", isolate)
      .Set("blockRealPointer", pointer)
      .Set("blockRealKeyboard", keyboard)
      .Set("keepRendering", automation_keep_rendering_)
      .Set("virtualCursor", std::move(cursor))
      .Set("inputActive",
           input_sequence_id_ != 0 || automation_agent_input_active_)
      .Set("rendering",
           base::DictValue()
               .Set("viewAvailable", available)
               .Set("keepAlive", !!agent_input_capture_ && available)
               .Set("requestedBackgroundThrottling",
                    requested_background_throttling_)
               .Set("effectiveBackgroundThrottling", background_throttling_));
}

void WebContents::BeginAutomationReset() {
  ++automation_input_generation_;
#if BUILDFLAG(IS_WIN)
  ++virtual_cursor_epoch_;
#endif
}

v8::Local<v8::Promise> WebContents::ResetAutomationOptions(
    gin::Arguments* args) {
  gin_helper::Promise<void> promise(args->isolate());
  auto handle = promise.GetHandle();
#if BUILDFLAG(IS_WIN)
  ++automation_input_generation_;
  if (input_sequence_ && input_sequence_id_)
    input_sequence_->Cancel("ABORTED");
  const auto epoch = ++virtual_cursor_epoch_;
  struct Reset {
    explicit Reset(gin_helper::Promise<void> p) : promise(std::move(p)) {}
    gin_helper::Promise<void> promise;
    base::RepeatingTimer timer;
    base::TimeTicks deadline = base::TimeTicks::Now() + base::Seconds(2);
  };
  auto state = std::make_shared<Reset>(std::move(promise));
  auto reset = base::BindRepeating(
      [](base::WeakPtr<WebContents> self, uint64_t epoch,
         std::shared_ptr<Reset> state) {
        if (!self || self->virtual_cursor_epoch_ != epoch) {
          state->timer.Stop();
          state->promise.RejectWithErrorMessage(
              "AUTOMATION_CONFIGURATION_SUPERSEDED");
          return;
        }
        if (self->input_sequence_id_ &&
            base::TimeTicks::Now() < state->deadline)
          return;
        const bool timed_out = self->input_sequence_id_ != 0;
        if (timed_out && self->input_sequence_)
          self->input_sequence_->Cancel("AUTOMATION_RESET_TIMEOUT");
        state->timer.Stop();
        if (self->virtual_cursor_) {
          self->virtual_cursor_->RestoreConfiguration(false, false, false,
                                                      false);
          self->virtual_cursor_->SetImage(gfx::ImageSkia(), gfx::PointF());
          self->virtual_cursor_->SetFrameRate(0);
        }
        self->automation_cursor_custom_image_ = false;
        self->automation_keep_rendering_ = false;
        self->SetAgentInputActive(false);
        if (timed_out) {
          state->promise.RejectWithErrorMessage("AUTOMATION_RESET_TIMEOUT");
          return;
        }
        auto current = base::BindRepeating(
            [](base::WeakPtr<WebContents> self, uint64_t epoch) {
              return self && self->virtual_cursor_epoch_ == epoch;
            },
            self, epoch);
        AutomationInputBarrier(self->web_contents(), std::move(state->promise),
                               std::move(current), base::OnceClosure());
      },
      GetWeakPtr(), epoch, state);
  if (input_sequence_id_)
    state->timer.Start(FROM_HERE, base::Milliseconds(8), std::move(reset));
  else
    reset.Run();
#else
  promise.RejectWithErrorMessage("AUTOMATION_PLATFORM_UNSUPPORTED");
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
  if (!error.empty()) {
    gin_helper::ErrorThrower(args->isolate()).ThrowError(error);
  } else {
    automation_cursor_custom_image_ = image != nullptr;
    ++automation_cursor_image_epoch_;
  }
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
  ++automation_cursor_frame_rate_epoch_;
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
