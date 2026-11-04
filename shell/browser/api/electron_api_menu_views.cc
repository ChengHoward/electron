// Copyright (c) 2014 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/api/electron_api_menu_views.h"

#include <memory>
#include <utility>

#include "base/auto_reset.h"
#include "gin/persistent.h"
#include "shell/browser/api/electron_api_base_window.h"
#include "shell/browser/api/electron_api_web_frame_main.h"
#include "shell/browser/native_window_views.h"
#include "shell/common/callback_util.h"
#include "shell/common/gin_helper/error_thrower.h"
#include "ui/display/screen.h"
#include "v8/include/cppgc/allocation.h"
#include "v8/include/v8-cppgc.h"

using views::MenuRunner;

namespace electron::api {

MenuViews::MenuViews(gin::Arguments* args) : Menu(args) {}

MenuViews::~MenuViews() {
  for (const auto& [id, adapter] : menu_adapters_)
    adapter->DetachViews();
  menu_runners_.clear();
  menu_adapters_.clear();
}

void MenuViews::Refresh(gin::Arguments* args) {
  if (initializing_) {
    gin_helper::ErrorThrower(args->isolate())
        .ThrowError("Cannot refresh menu during native control validation");
    return;
  }
  base::AutoReset<bool> validating(&initializing_, true);
  for (const auto& [id, adapter] : menu_adapters_)
    if (!adapter->Refresh(gin_helper::ErrorThrower(args->isolate())))
      return;
}

base::ListValue MenuViews::GetPopupState() const {
  base::ListValue states;
  for (const auto& [id, adapter] : menu_adapters_)
    states.Append(adapter->GetState());
  return states;
}

void MenuViews::Trace(cppgc::Visitor* visitor) const {
  Menu::Trace(visitor);
  visitor->Trace(weak_cell_factory_);
}

void MenuViews::PopupAt(BaseWindow* window,
                        std::optional<WebFrameMain*> frame,
                        int x,
                        int y,
                        int positioning_item,
                        ui::mojom::MenuSourceType source_type,
                        base::OnceClosure callback) {
  auto appearance = popup_appearance_.Clone();
  if (initializing_) {
    gin_helper::ErrorThrower(v8::Isolate::GetCurrent())
        .ThrowError("Cannot reopen menu during native control validation");
    return;
  }
  if (auto old = menu_runners_.find(window->weak_map_id());
      old != menu_runners_.end())
    old->second->Cancel();
  if (menu_runners_.contains(window->weak_map_id())) {
    std::move(callback).Run();
    return;
  }
  const NativeWindow* native_window = window->window();
  if (!native_window || native_window->widget()->IsClosed())
    return;

  // (-1, -1) means showing on mouse location.
  gfx::Point location;
  if (x == -1 || y == -1) {
    location = display::Screen::Get()->GetCursorScreenPoint();
  } else {
    gfx::Point origin = native_window->GetContentBounds().origin();
    location = gfx::Point(origin.x() + x, origin.y() + y);
  }

  int flags = MenuRunner::CONTEXT_MENU | MenuRunner::HAS_MNEMONICS;

  // Make sure the Menu object would not be garbage-collected until the callback
  // has run.
  base::OnceClosure callback_with_ref = BindSelfToClosure(std::move(callback));

  // Show the menu.
  //
  // Note that while views::MenuRunner accepts RepeatingCallback as close
  // callback, it is fine passing OnceCallback to it because we reset the
  // menu runner immediately when the menu is closed.
  int32_t window_id = window->weak_map_id();
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  auto close_callback = electron::AdaptCallbackForRepeating(
      base::BindOnce(&MenuViews::OnClosed,
                     gin::WrapPersistent(weak_cell_factory_.GetWeakCell(
                         isolate->GetCppHeap()->GetAllocationHandle())),
                     window_id, std::move(callback_with_ref)));
  auto adapter =
      std::make_unique<NativeMenuAdapter>(this, appearance, close_callback);
  {
    base::AutoReset<bool> validating(&initializing_, true);
    if (!adapter->Initialize(gin_helper::ErrorThrower(isolate)))
      return;
  }
  native_window = window->window();
  if (!native_window || native_window->widget()->IsClosed())
    return;
  auto runner = std::make_unique<MenuRunner>(adapter->CreateMenu(), flags);
  auto* const runner_ptr = runner.get();
  menu_adapters_[window_id] = std::move(adapter);
  menu_runners_[window_id] = std::move(runner);
  runner_ptr->RunMenuAt(native_window->widget(), nullptr,
                        gfx::Rect{location, gfx::Size{}},
                        views::MenuAnchorPosition::kTopLeft, source_type);

  // MenuRunner silently no-ops if another menu is active and never runs the
  // close callback; treat that as an immediate close so nothing leaks.
  if (auto iter = menu_runners_.find(window_id);
      iter != menu_runners_.end() && iter->second.get() == runner_ptr &&
      !runner_ptr->IsRunning()) {
    close_callback.Run();
  }
}

void MenuViews::ClosePopupAt(int32_t window_id) {
  if (auto iter = menu_runners_.find(window_id); iter != menu_runners_.end()) {
    // Close the runner for the window.
    iter->second->Cancel();
    return;
  }

  if (window_id == -1) {
    // When -1 is passed in, close all opened runners.
    // Note: `Cancel()` invalidaes iters, so move() to a temp before looping
    auto tmp = std::move(menu_runners_);
    for (auto& [id, runner] : tmp)
      runner->Cancel();
  }
}

void MenuViews::OnClosed(int32_t window_id, base::OnceClosure callback) {
  if (auto found = menu_adapters_.find(window_id);
      found != menu_adapters_.end())
    found->second->DetachViews();
  menu_runners_.erase(window_id);
  menu_adapters_.erase(window_id);
  std::move(callback).Run();
}

// static
Menu* Menu::Create(v8::Isolate* isolate, gin::Arguments* args) {
  Menu* menu = cppgc::MakeGarbageCollected<MenuViews>(
      isolate->GetCppHeap()->GetAllocationHandle(), args);
  return menu;
}

}  // namespace electron::api
