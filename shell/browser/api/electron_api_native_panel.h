// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_API_ELECTRON_API_NATIVE_PANEL_H_
#define ELECTRON_SHELL_BROWSER_API_ELECTRON_API_NATIVE_PANEL_H_

#include <memory>
#include <string>

#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "build/build_config.h"
#include "shell/common/gin_helper/event_emitter.h"

namespace electron {
class NativePanelHost;
namespace api {

class NativePanel final : public gin_helper::EventEmitter<NativePanel> {
 public:
  static gin_helper::WrappableBase* New(gin::Arguments* args);
  static v8::Local<v8::FunctionTemplate> GetConstructorTemplate(
      v8::Isolate* isolate);
  static v8::Local<v8::Function> GetConstructor(v8::Isolate* isolate);
  static void BuildPrototype(v8::Isolate* isolate,
                             v8::Local<v8::FunctionTemplate> prototype);
  static bool IsSupported();

  NativePanel(const NativePanel&) = delete;
  NativePanel& operator=(const NativePanel&) = delete;

 private:
  NativePanel();
  ~NativePanel() override;
  void Show(gin::Arguments* args);
  void Update(gin::Arguments* args);
  void Hide();
  void Destroy();
  bool IsDestroyed() const;
  base::DictValue GetState() const;
  base::DictValue Command(const base::DictValue& command);
  void OnAction(base::DictValue details);
  void OnDismissed(const std::string& reason);
  void OnClosed();
  bool destroyed_ = false;
  base::DictValue theme_;
  std::string background_material_ = "none";
  std::string scrollbar_placement_ = "gutter";
  int radius_ = 12;
  int content_inset_ = 12;
  bool shadow_ = true;
#if BUILDFLAG(IS_WIN)
  std::unique_ptr<NativePanelHost> host_;
#endif
  base::WeakPtrFactory<NativePanel> weak_factory_{this};
};

}  // namespace api
}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_API_ELECTRON_API_NATIVE_PANEL_H_
