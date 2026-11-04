// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license.
#include "shell/browser/api/input_sequence.h"

#include <algorithm>
#include <cmath>
#include <utility>

#include "base/functional/bind.h"
#include "base/power_monitor/power_monitor.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "content/browser/renderer_host/render_frame_host_impl.h"   // nogncheck
#include "content/browser/renderer_host/render_widget_host_impl.h"  // nogncheck
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "shell/browser/api/electron_api_web_contents.h"
#include "shell/common/gin_converters/callback_converter.h"
#include "shell/common/gin_converters/value_converter.h"
#include "shell/common/gin_helper/dictionary.h"
#include "shell/common/gin_helper/function_template.h"
#include "third_party/blink/public/mojom/widget/platform_widget.mojom.h"

namespace electron::api {
namespace {
double Number(const base::DictValue& value,
              std::string_view name,
              double fallback = 0) {
  const auto* entry = value.Find(name);
  return entry && (entry->is_int() || entry->is_double()) ? entry->GetDouble()
                                                          : fallback;
}
std::string String(const base::DictValue& value, std::string_view name) {
  const auto* entry = value.FindString(name);
  return entry ? *entry : "";
}
int Button(std::string_view name) {
  if (name == "left")
    return 1;
  if (name == "right")
    return 2;
  if (name == "middle")
    return 4;
  if (name == "back")
    return 8;
  if (name == "forward")
    return 16;
  return 0;
}
int Modifier(const base::DictValue& event) {
  const auto key = String(event, "key");
  const auto code = String(event, "code");
  if (key == "Alt" || code.starts_with("Alt"))
    return 1;
  if (key == "Control" || code.starts_with("Control"))
    return 2;
  if (key == "Meta" || code.starts_with("Meta"))
    return 4;
  if (key == "Shift" || code.starts_with("Shift"))
    return 8;
  return 0;
}
std::string Key(const base::DictValue& event) {
  auto code = String(event, "code");
  if (!code.empty())
    return code;
  return String(event, "key") + ":" +
         base::NumberToString(Number(event, "windowsVirtualKeyCode"));
}
void BindFrame(base::DictValue& params, content::RenderFrameHost* frame) {
  params.Set("_agentProcessId", frame->GetProcess()->GetID().GetUnsafeValue());
  params.Set("_agentRoutingId", frame->GetRoutingID());
  params.Set(
      "_agentDocumentToken",
      content::RenderFrameHostImpl::From(frame)->GetDocumentToken().ToString());
}
}  // namespace

InputSequence::InputSequence(WebContents* owner,
                             int id,
                             base::ListValue steps,
                             base::DictValue options,
                             gin_helper::Promise<base::DictValue> promise)
    : content::WebContentsObserver(owner->web_contents()),
      owner_(owner),
      id_(id),
      steps_(std::move(steps)),
      options_(std::move(options)),
      promise_(std::move(promise)),
      accepted_(base::TimeTicks::Now()) {}

InputSequence::~InputSequence() {
  base::PowerMonitor::GetInstance()->RemovePowerSuspendObserver(this);
}

void InputSequence::Start() {
  owner_->input_sequence_id_ = id_;
  owner_->SetAgentInputActive(true);
  main_document_ = web_contents()->GetPrimaryMainFrame()->GetWeakDocumentPtr();
  start_ = base::TimeTicks::Now();
  base::PowerMonitor::GetInstance()->AddPowerSuspendObserver(this);
  watchdog_.Start(
      FROM_HERE, base::Milliseconds(Number(options_, "timeoutMs", 30000)),
      base::BindOnce(&InputSequence::Finish, weak_factory_.GetWeakPtr(),
                     "failed", "TIMEOUT"));
  Next();
}

void InputSequence::Next() {
  if (finishing_)
    return;
  if (!web_contents() || !main_document_.AsRenderFrameHostIfValid()) {
    Finish("failed", "STALE_DOCUMENT");
    return;
  }
  if (index_ == steps_.size()) {
    if (dependency_) {
      dependency_ = false;
      Barrier(base::BindOnce(&InputSequence::Next, weak_factory_.GetWeakPtr()));
    } else {
      Finish("completed", "");
    }
    return;
  }
  if (dependency_) {
    dependency_ = false;
    Barrier(base::BindOnce(&InputSequence::Next, weak_factory_.GetWeakPtr()));
    return;
  }
  const auto due =
      start_ + base::Milliseconds(Number(steps_[index_].GetDict(), "atMs"));
  const auto now = base::TimeTicks::Now();
  if (now < due) {
    timer_.Start(FROM_HERE, due - now, this, &InputSequence::Next);
    return;
  }
  if ((now - due).InMillisecondsF() > Number(options_, "maxLatenessMs", 250)) {
    Finish("failed", "MAX_LATENESS_EXCEEDED");
    return;
  }
  params_ = steps_[index_].GetDict().Clone();
  params_.Set("_sequenceId", id_);
  const auto type = String(params_, "type");
  int next_buttons = pressed_buttons_;
  int next_modifiers = modifiers_;
  if (type == "mousePressed")
    next_buttons |= Button(String(params_, "button"));
  if (type == "mouseReleased")
    next_buttons &= ~Button(String(params_, "button"));
  if (type == "keyDown" || type == "rawKeyDown")
    next_modifiers |= Modifier(params_);
  if (type == "keyUp")
    next_modifiers &= ~Modifier(params_);
  if (!params_.contains("buttons"))
    params_.Set("buttons", next_buttons);
  if (!params_.contains("modifiers"))
    params_.Set("modifiers", next_modifiers);
  focus_started_ = base::TimeTicks::Now();
  focus_deadline_ = focus_started_ + base::Milliseconds(Number(
                                         options_, "focusTimeoutMs", 1000));
  StartDependencyTimer();
  Prepare();
}

void InputSequence::Prepare() {
  if (finishing_)
    return;
  auto* target = params_.FindDict("target");
  const bool keyboard = String(params_, "kind") == "key";
  const auto type = String(params_, "type");
  // keyUp follows the current page focus; do not refocus the keyDown element.
  if (!target || (keyboard && type == "keyUp")) {
    auto* frame = keyboard ? web_contents()->GetFocusedFrame()
                           : web_contents()->GetPrimaryMainFrame();
    if (!frame || !frame->IsRenderFrameLive()) {
      Finish("failed", "FOCUS_NOT_REACHED");
      return;
    }
    step_document_ = frame->GetWeakDocumentPtr();
    if (keyboard)
      BindFrame(params_, frame);
    dependency_timer_.Stop();
    Dispatch();
    return;
  }
  const int process = Number(*target, "processId", -1);
  const int routing = Number(*target, "routingId", -1);
  auto* frame = content::RenderFrameHost::FromID(process, routing);
  if (!frame || !frame->IsRenderFrameLive() ||
      content::WebContents::FromRenderFrameHost(frame) != web_contents() ||
      Number(*target, "webContentsId") != owner_->ID()) {
    Finish("failed", "STALE_DOCUMENT_OR_FRAME");
    return;
  }
  step_document_ = frame->GetWeakDocumentPtr();
  current_target_ = base::NumberToString(process) + ":" +
                    base::NumberToString(routing) + ":" +
                    base::NumberToString(Number(*target, "documentId")) + ":" +
                    base::NumberToString(Number(*target, "backendNodeId"));
  if (!renderer_.is_bound() || renderer_process_ != process ||
      renderer_routing_ != routing) {
    renderer_.reset();
    frame->GetRemoteInterfaces()->GetInterface(
        renderer_.BindNewPipeAndPassReceiver());
    renderer_process_ = process;
    renderer_routing_ = routing;
    renderer_.set_disconnect_handler(
        base::BindOnce(&InputSequence::Finish, weak_factory_.GetWeakPtr(),
                       "failed", "FRAME_UNAVAILABLE"));
  }
  const bool verify_focus = keyboard && focus_target_ == current_target_;
  renderer_->PrepareAgentTarget(
      Number(*target, "documentId"), Number(*target, "backendNodeId"),
      keyboard && !verify_focus, false, verify_focus,
      base::BindOnce(&InputSequence::Prepared, weak_factory_.GetWeakPtr()));
}

void InputSequence::Prepared(mojom::DomElementInfoPtr info,
                             const std::string& error) {
  if (finishing_)
    return;
  if (!info) {
    if (error == "FOCUS_NOT_REACHED" &&
        base::TimeTicks::Now() < focus_deadline_) {
      timer_.Start(FROM_HERE, base::Milliseconds(8), this,
                   &InputSequence::Prepare);
      return;
    }
    Finish("failed", error.empty() ? "FOCUS_NOT_REACHED" : error);
    return;
  }
  auto* frame = step_document_.AsRenderFrameHostIfValid();
  auto* view = frame ? frame->GetView() : nullptr;
  if (!frame || !view) {
    Finish("failed", "STALE_DOCUMENT_OR_FRAME");
    return;
  }
  const auto type = String(params_, "type");
  if (String(params_, "kind") == "key") {
    if (info->tag_name == "SELECT" || info->tag_name == "select") {
      const auto key = String(params_, "key");
      if ((static_cast<int>(Number(params_, "modifiers")) & 1) ||
          (key != "ArrowUp" && key != "ArrowDown" && key != "Home" &&
           key != "End" && key != "Tab")) {
        Finish("failed", "SELECT_KEY_UNSUPPORTED");
        return;
      }
    }
    focus_target_ = current_target_;
  } else {
    const double dsf = view->GetDeviceScaleFactor();
    const double scale =
        info->width > 0 ? info->bounds.width() / info->width / dsf : 1;
    params_.Set(
        "_agentLocalX",
        info->bounds.x() / dsf + Number(params_, "x", info->width / 2) * scale);
    params_.Set("_agentLocalY",
                info->bounds.y() / dsf +
                    Number(params_, "y", info->height / 2) * scale);
    params_.Set("x", Number(params_, "x", info->width / 2));
    params_.Set("y", Number(params_, "y", info->height / 2));
  }
  BindFrame(params_, frame);
  dependency_timer_.Stop();
  Dispatch();
}

void InputSequence::Dispatch() {
  if (finishing_)
    return;
  auto* frame = step_document_.AsRenderFrameHostIfValid();
  if (!frame || !frame->IsRenderFrameLive()) {
    Finish("failed", "STALE_DOCUMENT_OR_FRAME");
    return;
  }
  const double late = (base::TimeTicks::Now() - start_).InMillisecondsF() -
                      Number(params_, "atMs");
  if (late > Number(options_, "maxLatenessMs", 250)) {
    Finish("failed", "MAX_LATENESS_EXCEEDED");
    return;
  }
  pending_lateness_ = std::max(0., late);
  if (String(params_, "kind") == "key")
    dependency_widget_ =
        content::RenderWidgetHostImpl::From(frame->GetRenderWidgetHost())
            ->GetWeakPtr();
  v8::Isolate* isolate = promise_.isolate();
  v8::HandleScope scope(isolate);
  v8::Context::Scope context(promise_.GetContext());
  gin_helper::Dictionary dict(
      isolate, gin::ConvertToV8(isolate, params_).As<v8::Object>());
  ObservePromise(String(params_, "kind") == "mouse"
                     ? owner_->DispatchMouseEventParams(isolate, dict)
                     : owner_->DispatchKeyEventParams(isolate, dict),
                 false);
}

void InputSequence::ObservePromise(v8::Local<v8::Promise> promise,
                                   bool cleanup) {
  auto* isolate = promise_.isolate();
  auto ok =
      cleanup ? base::BindOnce(&InputSequence::CleanupAck,
                               weak_factory_.GetWeakPtr())
              : base::BindOnce(&InputSequence::Ack, weak_factory_.GetWeakPtr());
  auto bad = cleanup ? base::BindOnce(&InputSequence::CleanupRejected,
                                      weak_factory_.GetWeakPtr())
                     : base::BindOnce(&InputSequence::Rejected,
                                      weak_factory_.GetWeakPtr());
  auto result = promise->Then(
      promise_.GetContext(),
      gin::ConvertToV8(isolate, std::move(ok)).As<v8::Function>(),
      gin::ConvertToV8(isolate, std::move(bad)).As<v8::Function>());
  if (result.IsEmpty())
    Finish("failed", "PROMISE_UNAVAILABLE");
}

void InputSequence::Ack(v8::Local<v8::Value>) {
  if (finishing_)
    return;
  ++dispatched_;
  lateness_.push_back(pending_lateness_);
  const auto type = String(params_, "type");
  if (String(params_, "kind") == "mouse") {
    ++mouse_count_;
    last_mouse_ = params_.Clone();
    pressed_buttons_ = Number(params_, "buttons");
    if (type == "mousePressed" || type == "mouseReleased")
      focus_target_.clear();
  } else {
    ++key_count_;
    const auto key = Key(params_);
    if (type == "keyDown" || type == "rawKeyDown")
      held_keys_.insert_or_assign(key, params_.Clone());
    if (type == "keyUp")
      held_keys_.erase(key);
    modifiers_ = 0;
    for (const auto& [name, value] : held_keys_)
      modifiers_ |= Modifier(value);
  }
  dependency_ = type != "mouseMoved";
  ++index_;
  // Yield after every dispatch: no busy loop or unbounded overdue burst.
  timer_.Start(FROM_HERE, base::TimeDelta(), this, &InputSequence::Next);
}

void InputSequence::Rejected(v8::Local<v8::Value> error) {
  std::string reason;
  v8::String::Utf8Value text(promise_.isolate(), error);
  if (*text)
    reason = *text;
  Finish("failed", reason.empty() ? "DISPATCH_FAILED" : reason);
}

void InputSequence::Barrier(base::OnceClosure next) {
  if (!step_document_.AsRenderFrameHostIfValid() || !dependency_widget_) {
    Finish("failed", "STALE_DOCUMENT_OR_FRAME");
    return;
  }
  StartDependencyTimer();
  dependency_widget_->GetWidgetInputHandler()->PingMainThread(base::BindOnce(
      [](base::WeakPtr<InputSequence> self, base::OnceClosure next) {
        if (!self || self->finishing_)
          return;
        self->dependency_timer_.Stop();
        std::move(next).Run();
      },
      weak_factory_.GetWeakPtr(), std::move(next)));
}

void InputSequence::MouseRouted(content::RenderWidgetHostImpl* widget) {
  dependency_widget_ = widget->GetWeakPtr();
  pending_lateness_ =
      std::max(0., (base::TimeTicks::Now() - start_).InMillisecondsF() -
                       Number(params_, "atMs"));
}

std::string InputSequence::DispatchDeadlineError() const {
  if (finishing_)
    return "SEQUENCE_CANCELLED";
  const auto elapsed = (base::TimeTicks::Now() - start_).InMillisecondsF();
  if (elapsed >= Number(options_, "timeoutMs", 30000))
    return "TIMEOUT";
  if (elapsed - Number(params_, "atMs") >
      Number(options_, "maxLatenessMs", 250))
    return "MAX_LATENESS_EXCEEDED";
  return {};
}

void InputSequence::StartDependencyTimer() {
  const auto focus =
      base::Milliseconds(Number(options_, "focusTimeoutMs", 1000));
  const auto& step = steps_[std::min(index_, steps_.size() - 1)].GetDict();
  const auto late = start_ +
                    base::Milliseconds(Number(step, "atMs") +
                                       Number(options_, "maxLatenessMs", 250)) -
                    base::TimeTicks::Now();
  dependency_timer_.Start(
      FROM_HERE, std::max(base::TimeDelta(), std::min(focus, late)),
      base::BindOnce(&InputSequence::Finish, weak_factory_.GetWeakPtr(),
                     "failed",
                     late < focus ? "MAX_LATENESS_EXCEEDED" : "FOCUS_TIMEOUT"));
}

void InputSequence::Cancel(const std::string& reason) {
  if (finishing_ && !settled_ && reason != "ABORTED") {
    cleanup_failed_ += cleanup_.size();
    cleanup_.clear();
    weak_factory_.InvalidateWeakPtrs();
    Settle();
    return;
  }
  Finish(reason == "ABORTED" || reason == "SYSTEM_RESUMED" ? "cancelled"
                                                           : "failed",
         reason);
}

void InputSequence::Finish(const std::string& status,
                           const std::string& reason) {
  if (finishing_)
    return;
  finishing_ = true;
  status_ = status;
  reason_ = reason;
  weak_factory_.InvalidateWeakPtrs();
  owner_->input_sequence_id_ =
      -id_;  // Fence callbacks already resolving a widget.
  timer_.Stop();
  watchdog_.Stop();
  dependency_timer_.Stop();
  renderer_.reset();
  if (status_ == "completed" && (pressed_buttons_ || !held_keys_.empty())) {
    status_ = "failed";
    reason_ = "UNBALANCED_INPUT_STATE";
  }
  const bool safe =
      web_contents() && main_document_.AsRenderFrameHostIfValid() &&
      reason != "DOCUMENT_CHANGED" && reason != "WEBCONTENTS_DESTROYED" &&
      reason != "RENDERER_GONE";
  for (const auto& [key, value] : held_keys_) {
    if (!safe) {
      ++cleanup_failed_;
      continue;
    }
    auto up = value.Clone();
    up.Set("type", "keyUp");
    up.Set("_sequenceId", -id_);
    cleanup_.push_back(std::move(up));
  }
  for (const auto& name : {"left", "right", "middle", "back", "forward"}) {
    if (!(pressed_buttons_ & Button(name)))
      continue;
    if (!safe) {
      ++cleanup_failed_;
      continue;
    }
    auto up = last_mouse_.Clone();
    pressed_buttons_ &= ~Button(name);
    up.Set("type", "mouseReleased");
    up.Set("button", name);
    up.Set("buttons", pressed_buttons_);
    up.Set("_sequenceId", -id_);
    cleanup_.push_back(std::move(up));
  }
  held_keys_.clear();
  std::reverse(cleanup_.begin(), cleanup_.end());
  watchdog_.Start(FROM_HERE, base::Seconds(1),
                  base::BindOnce(
                      [](base::WeakPtr<InputSequence> self) {
                        if (!self || self->settled_)
                          return;
                        self->cleanup_failed_ += self->cleanup_.size();
                        self->cleanup_.clear();
                        self->Settle();
                      },
                      weak_factory_.GetWeakPtr()));
  CleanupNext();
}

void InputSequence::CleanupNext() {
  if (settled_)
    return;
  if (!web_contents() || !main_document_.AsRenderFrameHostIfValid()) {
    cleanup_failed_ += cleanup_.size();
    cleanup_.clear();
  }
  if (cleanup_.empty()) {
    Settle();
    return;
  }
  auto* isolate = promise_.isolate();
  v8::HandleScope scope(isolate);
  v8::Context::Scope context(promise_.GetContext());
  auto& event = cleanup_.back();
  int remaining_modifiers = 0;
  for (size_t i = 0; i + 1 < cleanup_.size(); ++i) {
    if (String(cleanup_[i], "kind") == "key")
      remaining_modifiers |= Modifier(cleanup_[i]);
  }
  event.Set("modifiers", remaining_modifiers);
  if (String(event, "kind") == "key") {
    auto* focused = web_contents()->GetFocusedFrame();
    if (!focused || !focused->IsRenderFrameLive()) {
      ++cleanup_failed_;
      cleanup_.pop_back();
      CleanupNext();
      return;
    }
    BindFrame(event, focused);
  }
  gin_helper::Dictionary dict(
      isolate, gin::ConvertToV8(isolate, event).As<v8::Object>());
  ObservePromise(String(event, "kind") == "mouse"
                     ? owner_->DispatchMouseEventParams(isolate, dict)
                     : owner_->DispatchKeyEventParams(isolate, dict),
                 true);
}
void InputSequence::CleanupAck(v8::Local<v8::Value>) {
  if (settled_)
    return;
  ++cleanup_sent_;
  cleanup_.pop_back();
  CleanupNext();
}
void InputSequence::CleanupRejected(v8::Local<v8::Value>) {
  if (settled_)
    return;
  ++cleanup_failed_;
  cleanup_.pop_back();
  CleanupNext();
}

void InputSequence::Settle() {
  if (settled_)
    return;
  settled_ = true;
  watchdog_.Stop();
  owner_->input_sequence_id_ = 0;
  if (web_contents()) {
    owner_->SetAgentInputActive(false);
  }
  std::sort(lateness_.begin(), lateness_.end());
  auto percentile = [&](double p) {
    return lateness_.empty()
               ? 0.
               : lateness_[static_cast<size_t>((lateness_.size() - 1) * p)];
  };
  base::DictValue result;
  result.Set("status", status_);
  result.Set("reason", reason_);
  result.Set("dispatchedCount", dispatched_);
  result.Set("mouseCount", mouse_count_);
  result.Set("keyCount", key_count_);
  result.Set("lastDispatchedIndex",
             dispatched_ ? base::Value(dispatched_ - 1) : base::Value());
  result.Set("stoppedIndex", status_ == "completed"
                                 ? base::Value()
                                 : base::Value(static_cast<int>(index_)));
  result.Set("executionMs",
             (base::TimeTicks::Now() - accepted_).InMillisecondsF());
  result.Set("lateness", base::DictValue()
                             .Set("p50", percentile(.50))
                             .Set("p95", percentile(.95))
                             .Set("p99", percentile(.99))
                             .Set("max", percentile(1)));
  result.Set("cleanup", base::DictValue()
                            .Set("dispatched", cleanup_sent_)
                            .Set("failed", cleanup_failed_));
  promise_.Resolve(result);
  steps_.clear();
  cleanup_.clear();
}

void InputSequence::WebContentsDestroyed() {
  Cancel("WEBCONTENTS_DESTROYED");
}
void InputSequence::PrimaryMainFrameRenderProcessGone(base::TerminationStatus) {
  Cancel("RENDERER_GONE");
}
void InputSequence::DidFinishNavigation(content::NavigationHandle* navigation) {
  if (navigation->HasCommitted() && !navigation->IsSameDocument())
    Cancel("DOCUMENT_CHANGED");
}
void InputSequence::OnResume() {
  Cancel("SYSTEM_RESUMED");
}
}  // namespace electron::api
