// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_UI_VIEWS_NATIVE_PANEL_H_
#define ELECTRON_SHELL_BROWSER_UI_VIEWS_NATIVE_PANEL_H_

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "base/win/windows_types.h"
#include "ui/events/event_handler.h"
#include "ui/events/event_observer.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/views/controls/textfield/textfield_controller.h"
#include "ui/views/widget/widget_observer.h"

namespace views {
class EventMonitor;
class ScrollView;
class View;
class ViewTracker;
class Widget;
class WidgetDelegate;
}  // namespace views

namespace electron {

// These descriptions contain data only. The API bridge validates the complete
// description before mutating a Widget or an existing control.
struct NativePanelNode {
  NativePanelNode();
  NativePanelNode(NativePanelNode&&);
  NativePanelNode& operator=(NativePanelNode&&);
  ~NativePanelNode();
  std::string id;
  std::string type;
  base::DictValue properties;
  gfx::ImageSkia image;
  std::vector<NativePanelNode> children;
};

struct NativePanelOptions {
  NativePanelOptions();
  NativePanelOptions(NativePanelOptions&&);
  ~NativePanelOptions();
  NativePanelNode content;
  base::DictValue theme;
  int radius = 12;
  int content_inset = 12;
  bool shadow = true;
  std::string focus_mode = "menu";
  bool dismiss_on_outside_click = true;
  bool dismiss_on_escape = true;
};

class NativePanelSurface;

class NativePanelHost final : private views::WidgetObserver,
                              private views::TextfieldController,
                              private ui::EventHandler,
                              private ui::EventObserver {
 public:
  using ActionCallback = base::RepeatingCallback<void(base::DictValue)>;
  using DismissCallback = base::RepeatingCallback<void(const std::string&)>;

  NativePanelHost(views::Widget* parent,
                  NativePanelOptions options,
                  ActionCallback action,
                  DismissCallback dismissed,
                  base::RepeatingClosure closed);
  ~NativePanelHost() override;
  NativePanelHost(const NativePanelHost&) = delete;
  NativePanelHost& operator=(const NativePanelHost&) = delete;

  void Show(const gfx::Rect& anchor, const std::string& placement);
  void UpdateContent(NativePanelNode content);
  void UpdateAppearance(base::DictValue theme,
                        int radius,
                        bool shadow,
                        int content_inset);
  void UpdateAnchor(const gfx::Rect& anchor);
  void Hide(bool restore_focus = true);
  void Destroy();
  bool IsValid() const { return native_windows_valid_; }
  base::DictValue GetState() const;

  // Called from the process-wide, non-consuming mouse hook. Posting the check
  // lets the original OS click finish dispatching before JS can change state.
  void OnGlobalMouseDown(gfx::Point screen_point, HWND target);

 private:
  struct Entry;
  Entry& Reconcile(const NativePanelNode& node,
                   views::View* parent,
                   size_t index);
  std::unique_ptr<views::View> CreateControl(const NativePanelNode& node,
                                             Entry* entry);
  void ApplyProperties(const NativePanelNode& node, Entry* entry);
  void ApplyTheme();
  void EnsureShadowWindow();
  void UpdateInputRegion();
  void RemoveSubtree(views::View* root);
  void LayoutAtAnchor();
  void Dismiss(const std::string& reason);
  void SendAction(const std::string& id, const std::string& type);
  void ApplyDeferredInput(const std::string& id);
  void RestoreFocus();
  bool IsComposing() const;
  bool IsRelatedWindow(HWND target) const;
  bool HitTestScreenPoint(gfx::Point screen_point) const;
  void InstallWindowHook();
  void RemoveWindowHook();
  static LRESULT CALLBACK WindowProcedure(HWND window,
                                          UINT message,
                                          WPARAM wparam,
                                          LPARAM lparam);

  // views::WidgetObserver:
  void OnWidgetBoundsChanged(views::Widget* widget,
                             const gfx::Rect& bounds) override;
  void OnWidgetVisibilityChanged(views::Widget* widget, bool visible) override;
  void OnWidgetActivationChanged(views::Widget* widget, bool active) override;
  void OnWidgetDestroying(views::Widget* widget) override;
  void OnWidgetShowStateChanged(views::Widget* widget) override;
  void OnWidgetThemeChanged(views::Widget* widget) override;

  // TextfieldController and event handling:
  void ContentsChanged(views::Textfield* sender,
                       const std::u16string& contents) override;
  void OnAfterUserAction(views::Textfield* sender) override;
  bool HandleKeyEvent(views::Textfield* sender,
                      const ui::KeyEvent& event) override;
  void OnKeyEvent(ui::KeyEvent* event) override;
  using ui::EventHandler::OnEvent;
  void OnEvent(const ui::Event& event) override;

  raw_ptr<views::Widget> parent_ = nullptr;
  std::unique_ptr<views::WidgetDelegate> delegate_;
  std::unique_ptr<views::Widget> widget_;
  std::unique_ptr<views::WidgetDelegate> shadow_delegate_;
  std::unique_ptr<views::Widget> shadow_widget_;
  raw_ptr<NativePanelSurface> shadow_surface_ = nullptr;
  raw_ptr<NativePanelSurface> surface_ = nullptr;
  raw_ptr<views::ScrollView> outer_scroll_ = nullptr;
  raw_ptr<views::View> content_container_ = nullptr;
  std::map<std::string, std::unique_ptr<Entry>> entries_;
  std::map<std::string, std::unique_ptr<views::View>> detached_;
  std::string reveal_selection_;
  std::unique_ptr<views::ViewTracker> restore_focus_;
  std::unique_ptr<views::EventMonitor> event_monitor_;
  NativePanelOptions options_;
  gfx::Rect anchor_;
  gfx::Rect parent_bounds_;
  std::string placement_ = "auto";
  bool visible_ = false;
  bool applying_ = false;
  bool applying_theme_ = false;
  bool destroying_ = false;
  bool native_windows_valid_ = false;
  HWND hwnd_ = nullptr;
  bool applying_input_region_ = false;
  using WindowProc = LRESULT(CALLBACK*)(HWND, UINT, WPARAM, LPARAM);
  WindowProc previous_window_proc_ = nullptr;
  ActionCallback action_;
  DismissCallback dismissed_;
  base::RepeatingClosure closed_;
  base::WeakPtrFactory<NativePanelHost> weak_factory_{this};
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_UI_VIEWS_NATIVE_PANEL_H_
