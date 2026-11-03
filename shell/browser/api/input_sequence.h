// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license.
#ifndef ELECTRON_SHELL_BROWSER_API_INPUT_SEQUENCE_H_
#define ELECTRON_SHELL_BROWSER_API_INPUT_SEQUENCE_H_

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/power_monitor/power_observer.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents_observer.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "shell/common/api/api.mojom.h"
#include "shell/common/gin_helper/promise.h"

namespace content {
class RenderWidgetHostImpl;
}

namespace electron::api {
class WebContents;
class InputSequence final : public content::WebContentsObserver,
                            public base::PowerSuspendObserver {
 public:
  InputSequence(WebContents* owner,
                int id,
                base::ListValue steps,
                base::DictValue options,
                gin_helper::Promise<base::DictValue> promise);
  ~InputSequence() override;
  void Start();
  void Cancel(const std::string& reason);
  void MouseRouted(content::RenderWidgetHostImpl* widget);
  std::string DispatchDeadlineError() const;

 private:
  void Next();
  void Prepare();
  void Prepared(mojom::DomElementInfoPtr info, const std::string& error);
  void Dispatch();
  void Ack(v8::Local<v8::Value>);
  void Rejected(v8::Local<v8::Value> error);
  void Barrier(base::OnceClosure next);
  void StartDependencyTimer();
  void Finish(const std::string& status, const std::string& reason);
  void Settle();
  void CleanupNext();
  void CleanupAck(v8::Local<v8::Value>);
  void CleanupRejected(v8::Local<v8::Value>);
  void ObservePromise(v8::Local<v8::Promise> promise, bool cleanup);
  void WebContentsDestroyed() override;
  void PrimaryMainFrameRenderProcessGone(base::TerminationStatus) override;
  void DidFinishNavigation(content::NavigationHandle*) override;
  void OnResume() override;
  raw_ptr<WebContents> owner_;
  int id_;
  base::ListValue steps_;
  base::DictValue options_;
  gin_helper::Promise<base::DictValue> promise_;
  content::WeakDocumentPtr main_document_;
  content::WeakDocumentPtr step_document_;
  base::WeakPtr<content::RenderWidgetHostImpl> dependency_widget_;
  mojo::Remote<mojom::ElectronRenderer> renderer_;
  int renderer_process_ = -1;
  int renderer_routing_ = -1;
  base::TimeTicks accepted_;
  base::TimeTicks start_;
  base::TimeTicks focus_deadline_;
  base::TimeTicks focus_started_;
  base::OneShotTimer timer_;
  base::OneShotTimer watchdog_;
  base::OneShotTimer dependency_timer_;
  size_t index_ = 0;
  int dispatched_ = 0;
  int mouse_count_ = 0;
  int key_count_ = 0;
  int pressed_buttons_ = 0;
  int modifiers_ = 0;
  int cleanup_sent_ = 0;
  int cleanup_failed_ = 0;
  bool previous_throttled_ = true;
  bool finishing_ = false;
  bool settled_ = false;
  bool dependency_ = false;
  std::string focus_target_;
  std::string current_target_;
  base::DictValue params_;
  base::DictValue last_mouse_;
  std::map<std::string, base::DictValue> held_keys_;
  std::vector<base::DictValue> cleanup_;
  std::vector<double> lateness_;
  double pending_lateness_ = 0;
  std::string status_;
  std::string reason_;
  base::WeakPtrFactory<InputSequence> weak_factory_{this};
};
}  // namespace electron::api
#endif
