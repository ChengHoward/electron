// Copyright (c) 2014 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_API_ELECTRON_API_MENU_VIEWS_H_
#define ELECTRON_SHELL_BROWSER_API_ELECTRON_API_MENU_VIEWS_H_

#include <memory>

#include "base/containers/flat_map.h"
#include "gin/weak_cell.h"
#include "shell/browser/api/electron_api_menu.h"
#include "shell/browser/ui/views/native_menu.h"
#include "ui/views/controls/menu/menu_runner.h"

namespace electron::api {

class MenuViews : public Menu {
 public:
  explicit MenuViews(gin::Arguments* args);
  ~MenuViews() override;

  void Trace(cppgc::Visitor*) const override;
  void Refresh(gin::Arguments* args) override;
  base::ListValue GetPopupState() const override;

 protected:
  // Menu
  void PopupAt(BaseWindow* window,
               std::optional<WebFrameMain*> frame,
               int x,
               int y,
               int positioning_item,
               ui::mojom::MenuSourceType source_type,
               base::OnceClosure callback) override;
  void ClosePopupAt(int32_t window_id) override;

 private:
  void OnClosed(int32_t window_id, base::OnceClosure callback);
  bool initializing_ = false;

  // window ID -> open context menu
  base::flat_map<int32_t, std::unique_ptr<views::MenuRunner>> menu_runners_;
  base::flat_map<int32_t, std::unique_ptr<NativeMenuAdapter>> menu_adapters_;

  gin::WeakCellFactory<MenuViews> weak_cell_factory_{this};
};

}  // namespace electron::api

#endif  // ELECTRON_SHELL_BROWSER_API_ELECTRON_API_MENU_VIEWS_H_
