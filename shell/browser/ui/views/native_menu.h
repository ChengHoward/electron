// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_UI_VIEWS_NATIVE_MENU_H_
#define ELECTRON_SHELL_BROWSER_UI_VIEWS_NATIVE_MENU_H_

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "shell/common/gin_helper/error_thrower.h"
#include "ui/views/controls/menu/menu_item_view.h"
#include "ui/views/controls/menu/menu_model_adapter.h"
#include "v8/include/cppgc/persistent.h"

namespace gin {
class Arguments;
}
namespace electron {
namespace api {
class Menu;
}
class MenuControlView;

// Owns the delegate and row controls for one popup. MenuViews keeps the JS menu
// alive and destroys the MenuRunner before destroying this adapter.
class NativeMenuAdapter final : public views::MenuModelAdapter {
 public:
  NativeMenuAdapter(api::Menu* menu,
                    const base::DictValue& appearance,
                    base::RepeatingClosure closed);
  ~NativeMenuAdapter() override;
  bool Initialize(gin_helper::ErrorThrower thrower);
  bool Refresh(gin_helper::ErrorThrower thrower);
  void BuildMenu(views::MenuItemView* menu) override;
  base::DictValue GetState() const;
  void DetachViews();

 private:
  struct Row;
  static bool ReadRows(api::Menu* menu,
                       std::map<int, std::unique_ptr<Row>>* output,
                       gin_helper::ErrorThrower thrower);
  views::MenuItemView* AppendMenuItem(views::MenuItemView* menu,
                                      ui::MenuModel* model,
                                      size_t index) override;
  void Activate(int command, const std::string& control);

  cppgc::WeakPersistent<api::Menu> menu_;
  base::DictValue appearance_options_;
  std::optional<views::MenuItemView::Appearance> appearance_;
  int width_ = 240;
  int submenu_width_ = 180;
  raw_ptr<views::MenuItemView> root_ = nullptr;
  std::map<int, std::unique_ptr<Row>> rows_;
  std::map<int, raw_ptr<MenuControlView>> views_;
  base::WeakPtrFactory<NativeMenuAdapter> weak_factory_{this};
};
}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_UI_VIEWS_NATIVE_MENU_H_
