// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/ui/views/native_menu.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <utility>
#include "base/functional/bind.h"
#include "base/i18n/rtl.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "cc/paint/paint_flags.h"
#include "gin/arguments.h"
#include "gin/dictionary.h"
#include "shell/browser/api/electron_api_menu.h"
#include "shell/browser/api/electron_api_menu_item.h"
#include "shell/common/gin_converters/image_converter.h"
#include "shell/common/gin_converters/std_converter.h"
#include "shell/common/gin_converters/value_converter.h"
#include "skia/ext/image_operations.h"
#include "ui/accessibility/ax_enums.mojom.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/models/image_model.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/color_utils.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/gfx/image/image_skia_operations.h"
#include "ui/native_theme/native_theme.h"
#include "ui/views/background.h"
#include "ui/views/border.h"
#include "ui/views/controls/button/label_button.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/menu/menu_scroll_view_container.h"
#include "ui/views/controls/menu/submenu_view.h"
#include "ui/views/layout/box_layout.h"
#include "ui/views/widget/widget.h"
#if BUILDFLAG(IS_WIN)
#include "ui/views/win/hwnd_util.h"
#endif

namespace electron {
namespace {
struct Control {
  std::string id;
  std::string type;
  std::u16string label;
  std::u16string name;
  gfx::ImageSkia icon;
  bool enabled = true;
  bool close = false;
  int group = 0;
};

base::DictValue RectValue(const gfx::Rect& rect) {
  return base::DictValue()
      .Set("x", rect.x())
      .Set("y", rect.y())
      .Set("width", rect.width())
      .Set("height", rect.height());
}

bool ParseColor(const std::string& value, SkColor* color) {
  uint32_t parsed;
  if ((value.size() != 7 && value.size() != 9) || value[0] != '#' ||
      !base::HexStringToUInt(value.substr(1), &parsed))
    return false;
  *color = value.size() == 7 ? parsed | 0xFF000000 : parsed;
  return true;
}

class MenuControlButton final : public views::LabelButton {
 public:
  MenuControlButton(PressedCallback callback,
                    const views::MenuItemView::Appearance& appearance,
                    const gfx::RoundedCornersF& corners)
      : LabelButton(std::move(callback), u""),
        hover_(color_utils::AlphaBlend(
            appearance.foreground,
            color_utils::AlphaBlend(appearance.hover,
                                    appearance.background,
                                    0.92f),
            0.05f)),
        pressed_(color_utils::AlphaBlend(
            appearance.foreground,
            color_utils::AlphaBlend(appearance.hover,
                                    appearance.background,
                                    0.92f),
            0.10f)),
        corners_(corners) {
    SetFocusBehavior(FocusBehavior::ALWAYS);
    SetEnabledTextColors(appearance.foreground);
    SetTextColor(STATE_DISABLED,
                 color_utils::AlphaBlend(appearance.foreground,
                                         appearance.background, 0.20f));
    label()->SetFontList(appearance.font);
    label()->SetAutoColorReadabilityEnabled(false);
    label()->SetSubpixelRenderingEnabled(false);
    SetBorder(views::CreateEmptyBorder(gfx::Insets(2)));
    SetMinSize(gfx::Size(24, 24));
    SetHorizontalAlignment(gfx::ALIGN_CENTER);
  }

 private:
  void StateChanged(ButtonState old_state) override {
    LabelButton::StateChanged(old_state);
    SetBackground(
        GetState() == STATE_HOVERED || GetState() == STATE_PRESSED
            ? views::CreateRoundedRectBackground(
                  GetState() == STATE_PRESSED ? pressed_ : hover_, corners_)
            : nullptr);
  }
  SkColor hover_;
  SkColor pressed_;
  gfx::RoundedCornersF corners_;
};
}  // namespace

class MenuControlView final : public views::View {
  METADATA_HEADER(MenuControlView, views::View)

 public:
  using Callback = base::RepeatingCallback<void(const std::string&)>;
  MenuControlView(const std::u16string& title,
                  const std::vector<Control>& controls,
                  const views::MenuItemView::Appearance& appearance,
                  Callback action)
      : appearance_(appearance) {
    GetViewAccessibility().SetRole(ax::mojom::Role::kMenu);
    GetViewAccessibility().SetName(title);
    auto* layout = SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal,
        gfx::Insets::VH(0, appearance.item_padding), 0));
    layout->set_cross_axis_alignment(
        views::BoxLayout::CrossAxisAlignment::kCenter);
    heading_ = AddChildView(std::make_unique<views::Label>(title));
    heading_->SetHorizontalAlignment(base::i18n::IsRTL() ? gfx::ALIGN_RIGHT
                                                         : gfx::ALIGN_LEFT);
    heading_->SetFontList(appearance.font);
    heading_->SetEnabledColor(appearance.foreground);
    heading_->SetAutoColorReadabilityEnabled(false);
    heading_->SetSubpixelRenderingEnabled(false);
    heading_->SetCanProcessEventsWithinSubtree(false);
    layout->SetFlexForView(heading_, 1);
    for (size_t i = 0; i < controls.size(); ++i) {
      const auto& control = controls[i];
      if (i && !control.group && controls[i - 1].group) {
        auto* spacer = AddChildView(std::make_unique<views::View>());
        spacer->SetPreferredSize(gfx::Size(4, 1));
      }
      std::unique_ptr<views::View> view;
      if (control.type == "label") {
        auto label = std::make_unique<views::Label>();
        label->SetFontList(appearance.font.DeriveWithSizeDelta(
            appearance.font.GetFontSize() > 6 ? -1 : 0));
        label->SetEnabledColor(appearance.foreground);
        label->SetAutoColorReadabilityEnabled(false);
        label->SetSubpixelRenderingEnabled(false);
        label->SetCanProcessEventsWithinSubtree(false);
        view = std::move(label);
      } else {
        float leading =
            !control.group || !i || controls[i - 1].group != control.group ? 8
                                                                           : 0;
        float trailing = !control.group || i + 1 == controls.size() ||
                                 controls[i + 1].group != control.group
                             ? 8
                             : 0;
        if (base::i18n::IsRTL())
          std::swap(leading, trailing);
        view = std::make_unique<MenuControlButton>(
            base::BindRepeating(action, control.id), appearance,
            gfx::RoundedCornersF(leading, trailing, trailing, leading));
      }
      controls_.push_back(AddChildView(std::move(view)));
    }
    Update(controls, title);
  }
  void Update(const std::vector<Control>& controls,
              const std::u16string& title) {
    heading_->SetText(title);
    descriptions_ = controls;
    for (size_t i = 0; i < controls.size(); ++i) {
      const auto& control = controls[i];
      auto* view = controls_[i].get();
      if (control.type == "label") {
        static_cast<views::Label*>(view)->SetText(control.label);
      } else {
        auto* button = static_cast<MenuControlButton*>(view);
        button->SetText(control.label);
        auto icon = control.icon.isNull()
                        ? gfx::ImageSkia()
                        : gfx::ImageSkiaOperations::CreateResizedImage(
                              control.icon, skia::ImageOperations::RESIZE_BEST,
                              gfx::Size(18, 18));
        button->SetImageModel(views::Button::STATE_NORMAL,
                              ui::ImageModel::FromImageSkia(icon));
        button->SetImageModel(
            views::Button::STATE_DISABLED,
            ui::ImageModel::FromImageSkia(
                icon.isNull()
                    ? gfx::ImageSkia()
                    : gfx::ImageSkiaOperations::CreateTransparentImage(icon,
                                                                       0.4f)));
      }
      view->SetEnabled(control.enabled);
      view->GetViewAccessibility().SetName(control.name.empty() ? control.label
                                                                : control.name);
      view->SetTooltipText(control.name);
      view->SetPreferredSize(gfx::Size(control.type == "label" ? 44 : 24, 24));
      view->SetBorder(views::CreateEmptyBorder(gfx::Insets::VH(0, 2)));
    }
    InvalidateLayout();
    SchedulePaint();
  }
  gfx::Size CalculatePreferredSize(
      const views::SizeBounds& available_size) const override {
    auto size = views::View::CalculatePreferredSize(available_size);
    size.set_height(std::max(size.height(), appearance_.row_height));
    return size;
  }
  base::ListValue GetState() const {
    base::ListValue result;
    for (size_t i = 0; i < controls_.size(); ++i)
      result.Append(
          base::DictValue()
              .Set("id", descriptions_[i].id)
              .Set("label", base::UTF16ToUTF8(descriptions_[i].label))
              .Set("type", descriptions_[i].type)
              .Set("group", descriptions_[i].group)
              .Set("enabled", controls_[i]->GetEnabled())
              .Set("hotTracked",
                   descriptions_[i].type == "button" &&
                       static_cast<MenuControlButton*>(controls_[i].get())
                           ->IsHotTracked())
              .Set("bounds", RectValue(controls_[i]->GetBoundsInScreen())));
    return result;
  }

 private:
  void OnPaintBackground(gfx::Canvas* canvas) override {
    // Groups implement Chromium AppMenu's native segmented zoom control.
    for (size_t i = 0; i < descriptions_.size();) {
      const int group = descriptions_[i].group;
      if (!group) {
        ++i;
        continue;
      }
      size_t end = i;
      while (end + 1 < descriptions_.size() &&
             descriptions_[end + 1].group == group)
        ++end;
      gfx::Rect bounds = controls_[i]->bounds();
      bounds.Union(controls_[end]->bounds());
      cc::PaintFlags flags;
      flags.setAntiAlias(true);
      flags.setColor(color_utils::AlphaBlend(appearance_.hover,
                                             appearance_.background, 0.92f));
      canvas->DrawRoundRect(bounds, 8, flags);
      flags.setStyle(cc::PaintFlags::kStroke_Style);
      flags.setStrokeWidth(1);
      const SkColor border = color_utils::AlphaBlend(
          appearance_.border, appearance_.background, 0.78f);
      flags.setColor(border);
      canvas->DrawRoundRect(bounds, 8, flags);
      for (size_t j = i; j < end; ++j)
        canvas->FillRect(gfx::Rect(controls_[j]->bounds().right(),
                                   bounds.y() + 3, 1, bounds.height() - 6),
                         border);
      i = end + 1;
    }
  }
  views::MenuItemView::Appearance appearance_;
  raw_ptr<views::Label> heading_ = nullptr;
  std::vector<Control> descriptions_;
  std::vector<raw_ptr<views::View>> controls_;
};

BEGIN_METADATA(MenuControlView)
END_METADATA

struct NativeMenuAdapter::Row {
  std::string id;
  std::u16string label;
  std::vector<Control> controls;
};

NativeMenuAdapter::NativeMenuAdapter(api::Menu* menu,
                                     const base::DictValue& appearance,
                                     base::RepeatingClosure closed)
    : views::MenuModelAdapter(menu->model(), std::move(closed)),
      menu_(menu),
      appearance_options_(appearance.Clone()) {}
NativeMenuAdapter::~NativeMenuAdapter() = default;

void NativeMenuAdapter::DetachViews() {
  root_ = nullptr;
  views_.clear();
}

base::DictValue NativeMenuAdapter::GetState() const {
  base::DictValue result;
  if (!root_ || !root_->HasSubmenu() || !root_->GetSubmenu()->GetWidget())
    return result;
  auto* widget = root_->GetSubmenu()->GetWidget();
  result.Set("bounds", RectValue(widget->GetWindowBoundsInScreen()));
  auto body = widget->GetWindowBoundsInScreen();
  body.Inset(
      root_->GetSubmenu()->GetScrollViewContainer()->outside_border_insets());
  result.Set("contentBounds", RectValue(body));
#if BUILDFLAG(IS_WIN)
  result.Set("windowHandle", std::to_string(reinterpret_cast<uintptr_t>(
                                 views::HWNDForWidget(widget))));
#endif
  base::ListValue rows;
  for (const auto& [command, view] : views_)
    rows.Append(base::DictValue()
                    .Set("id", rows_.at(command)->id)
                    .Set("controls", view->GetState()));
  result.Set("rows", std::move(rows));
  base::ListValue items;
  for (const auto* item : root_->GetSubmenu()->GetMenuItems())
    items.Append(base::DictValue()
                     .Set("label", base::UTF16ToUTF8(item->title()))
                     .Set("bounds", RectValue(item->GetBoundsInScreen())));
  result.Set("items", std::move(items));
  return result;
}

bool NativeMenuAdapter::Initialize(gin_helper::ErrorThrower thrower) {
  if (!appearance_options_.empty()) {
    auto fail = [&] {
      thrower.ThrowTypeError("Invalid Menu appearance");
      return false;
    };
    const std::set<std::string> allowed = {"_custom",
                                           "theme",
                                           "width",
                                           "submenuWidth",
                                           "fontFamily",
                                           "fontSize",
                                           "rowHeight",
                                           "radius",
                                           "itemRadius",
                                           "padding",
                                           "itemPadding",
                                           "separatorInset",
                                           "separatorSpacing",
                                           "background",
                                           "foreground",
                                           "hover",
                                           "border"};
    for (const auto [key, value] : appearance_options_)
      if (!allowed.contains(key))
        return fail();
    const auto* mode = appearance_options_.FindString("theme");
    if (appearance_options_.contains("theme") && !mode)
      return fail();
    if (mode && *mode != "system" && *mode != "light" && *mode != "dark")
      return fail();
    const bool dark = mode && *mode != "system"
                          ? *mode == "dark"
                          : ui::NativeTheme::GetInstanceForNativeUi()
                                    ->preferred_color_scheme() ==
                                ui::NativeTheme::PreferredColorScheme::kDark;
    appearance_.emplace();
    auto& style = *appearance_;
    if (dark) {
      style.background = SkColorSetRGB(41, 42, 45);
      style.foreground = SkColorSetRGB(238, 238, 238);
      style.hover = SkColorSetRGB(62, 63, 66);
      style.border = SkColorSetRGB(79, 80, 83);
    }
    int font_size = 14;
    const struct {
      const char* key;
      int* out;
      int min;
      int max;
    } metrics[] = {{"width", &width_, 120, 1600},
                   {"submenuWidth", &submenu_width_, 80, 1600},
                   {"fontSize", &font_size, 6, 48},
                   {"rowHeight", &style.row_height, 20, 100},
                   {"radius", &style.radius, 0, 64},
                   {"itemRadius", &style.item_radius, 0, 50},
                   {"padding", &style.padding, 1, 32},
                   {"itemPadding", &style.item_padding, 0, 64},
                   {"separatorInset", &style.separator_inset, 0, 100},
                   {"separatorSpacing", &style.separator_spacing, 1, 64}};
    for (const auto& metric : metrics) {
      if (!appearance_options_.contains(metric.key))
        continue;
      auto value = appearance_options_.FindDouble(metric.key);
      if (!value || !std::isfinite(*value) || std::floor(*value) != *value ||
          *value < metric.min || *value > metric.max)
        return fail();
      *metric.out = *value;
    }
    const struct {
      const char* key;
      SkColor* out;
    } colors[] = {{"background", &style.background},
                  {"foreground", &style.foreground},
                  {"hover", &style.hover},
                  {"border", &style.border}};
    for (const auto& color : colors) {
      if (!appearance_options_.contains(color.key))
        continue;
      const auto* value = appearance_options_.FindString(color.key);
      if (!value || !ParseColor(*value, color.out))
        return fail();
    }
    const auto* family = appearance_options_.FindString("fontFamily");
    if (appearance_options_.contains("fontFamily") &&
        (!family || family->empty() || family->size() > 256))
      return fail();
    style.font =
        gfx::FontList(std::vector<std::string>{family ? *family : "Segoe UI"},
                      gfx::Font::NORMAL, font_size, gfx::Font::Weight::NORMAL);
  }
  if (!ReadRows(menu_.Get(), &rows_, thrower))
    return false;
#if !BUILDFLAG(IS_WIN)
  if (!rows_.empty()) {
    thrower.ThrowError(
        "Inline native menu controls are supported on Windows only");
    return false;
  }
#endif
  if (!appearance_ && !rows_.empty()) {
    appearance_.emplace();
    appearance_->font = views::MenuConfig::instance().font_list;
    if (ui::NativeTheme::GetInstanceForNativeUi()->preferred_color_scheme() ==
        ui::NativeTheme::PreferredColorScheme::kDark) {
      appearance_->background = SkColorSetRGB(41, 42, 45);
      appearance_->foreground = SkColorSetRGB(238, 238, 238);
      appearance_->hover = SkColorSetRGB(62, 63, 66);
      appearance_->border = SkColorSetRGB(79, 80, 83);
    }
  }
  return true;
}

bool NativeMenuAdapter::ReadRows(api::Menu* menu,
                                 std::map<int, std::unique_ptr<Row>>* output,
                                 gin_helper::ErrorThrower thrower) {
  auto fail = [&] {
    thrower.ThrowTypeError(
        "Invalid MenuItem.controls: expected 1..8 uniquely identified native "
        "buttons or labels");
    return false;
  };
  for (size_t i = 0; i < menu->GetItemCount(); ++i) {
    auto* item = menu->ItemAt(i);
    if (item->submenu() && !ReadRows(item->submenu(), output, thrower))
      return false;
    v8::Local<v8::Object> wrapper;
    if (!item->GetWrapper(thrower.isolate()).ToLocal(&wrapper))
      return fail();
    gin::Dictionary dictionary(thrower.isolate(), wrapper);
    v8::Local<v8::Value> value;
    if (!dictionary.Get("controls", &value) || value->IsUndefined())
      continue;
    std::vector<v8::Local<v8::Value>> controls;
    auto row = std::make_unique<Row>();
    if (item->type() != api::MenuItem::Type::kNormal ||
        !dictionary.Get("id", &row->id) || row->id.empty() ||
        !gin::ConvertFromV8(thrower.isolate(), value, &controls) ||
        controls.empty() || controls.size() > 8)
      return fail();
    row->label = item->label();
    std::set<std::string> ids;
    for (auto control_value : controls) {
      if (!control_value->IsObject() || control_value->IsArray() ||
          control_value->IsNull())
        return fail();
      gin::Dictionary description(thrower.isolate(),
                                  control_value.As<v8::Object>());
      Control control;
      if (!description.Get("id", &control.id) || control.id.empty() ||
          control.id.size() > 256 || !ids.insert(control.id).second ||
          !description.Get("type", &control.type) ||
          (control.type != "button" && control.type != "label"))
        return fail();
      // Reject unknown fields so misspellings never silently change actions.
      v8::Local<v8::Array> keys;
      if (!control_value.As<v8::Object>()
               ->GetOwnPropertyNames(thrower.isolate()->GetCurrentContext())
               .ToLocal(&keys))
        return fail();
      const std::set<std::string> allowed = {
          "id",      "type",         "label", "icon", "accessibleName",
          "enabled", "closeOnClick", "group"};
      for (uint32_t j = 0; j < keys->Length(); ++j) {
        v8::Local<v8::Value> key;
        std::string name;
        if (!keys->Get(thrower.isolate()->GetCurrentContext(), j)
                 .ToLocal(&key) ||
            !gin::ConvertFromV8(thrower.isolate(), key, &name) ||
            !allowed.contains(name))
          return fail();
      }
      auto optional = [&](const char* name, auto* out) {
        v8::Local<v8::Value> field;
        return !description.Get(name, &field) || field->IsUndefined() ||
               gin::ConvertFromV8(thrower.isolate(), field, out);
      };
      if (!optional("label", &control.label) ||
          !optional("accessibleName", &control.name) ||
          !optional("icon", &control.icon) ||
          !optional("enabled", &control.enabled) ||
          !optional("closeOnClick", &control.close) ||
          !optional("group", &control.group) || control.group < 0 ||
          control.group > 8 || control.label.size() > 1024 ||
          (control.type == "button" && control.label.empty() &&
           (control.icon.isNull() || control.name.empty())))
        return fail();
      row->controls.push_back(std::move(control));
    }
    output->emplace(item->command_id(), std::move(row));
  }
  return true;
}

void NativeMenuAdapter::BuildMenu(views::MenuItemView* menu) {
  views_.clear();
  root_ = menu;
  if (appearance_)
    menu->SetAppearance(*appearance_);
  views::MenuModelAdapter::BuildMenu(menu);
  if (appearance_) {
    auto size = [&](auto&& self, views::MenuItemView* item, bool root) -> void {
      if (!item->HasSubmenu())
        return;
      item->GetSubmenu()->set_minimum_preferred_width(root ? width_
                                                           : submenu_width_);
      for (auto* child : item->GetSubmenu()->GetMenuItems()) {
        child->set_vertical_margin(0);
        self(self, child, false);
      }
    };
    size(size, menu, true);
  }
}

views::MenuItemView* NativeMenuAdapter::AppendMenuItem(
    views::MenuItemView* menu,
    ui::MenuModel* model,
    size_t index) {
  auto* item = views::MenuModelAdapter::AppendMenuItem(menu, model, index);
  auto found = rows_.find(model->GetCommandIdAt(index));
  if (found != rows_.end()) {
    const auto& row = *found->second;
    views::MenuItemView::Appearance fallback;
    auto* view = item->AddChildView(std::make_unique<MenuControlView>(
        row.label, row.controls, appearance_ ? *appearance_ : fallback,
        base::BindRepeating(&NativeMenuAdapter::Activate,
                            weak_factory_.GetWeakPtr(), found->first)));
    views_[found->first] = view;
    item->SetTitle(u"");
    item->set_children_use_full_width(true);
  }
  return item;
}

bool NativeMenuAdapter::Refresh(gin_helper::ErrorThrower thrower) {
  auto alive = weak_factory_.GetWeakPtr();
  std::map<int, std::unique_ptr<Row>> next;
  if (!menu_ || !ReadRows(menu_.Get(), &next, thrower))
    return false;
  if (!alive)
    return false;
  if (next.size() != rows_.size()) {
    thrower.ThrowTypeError("Cannot change open menu control structure");
    return false;
  }
  for (const auto& [command, row] : next) {
    auto old = rows_.find(command);
    if (old == rows_.end() ||
        old->second->controls.size() != row->controls.size()) {
      thrower.ThrowTypeError("Cannot change open menu control structure");
      return false;
    }
    for (size_t i = 0; i < row->controls.size(); ++i)
      if (row->controls[i].id != old->second->controls[i].id ||
          row->controls[i].group != old->second->controls[i].group ||
          row->controls[i].type != old->second->controls[i].type) {
        thrower.ThrowTypeError("Cannot change open menu control ids or types");
        return false;
      }
  }
  // Validation above is complete before changing any live native control.
  rows_ = std::move(next);
  for (const auto& [command, view] : views_)
    view->Update(rows_.at(command)->controls, rows_.at(command)->label);
  return true;
}

void NativeMenuAdapter::Activate(int command, const std::string& control_id) {
  const auto found = rows_.find(command);
  if (found == rows_.end())
    return;
  const auto& row = *found->second;
  for (const auto& control : row.controls) {
    if (control.id != control_id || !control.enabled ||
        control.type != "button")
      continue;
    const auto detail =
        base::DictValue().Set("itemId", row.id).Set("controlId", control_id);
    auto* menu = menu_.Get();
    if (!menu)
      return;
    auto* isolate = v8::Isolate::GetCurrent();
    v8::HandleScope scope(isolate);
    // Keep a strong stack handle across close, callback reentry and GC.
    v8::Local<v8::Object> keep_alive;
    if (!menu->GetWrapper(isolate).ToLocal(&keep_alive))
      return;
    if (control.close)
      root_->Cancel();
    menu->EmitWithoutEvent("control-action", detail);
    return;
  }
}
}  // namespace electron
