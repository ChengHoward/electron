// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/ui/views/native_panel.h"

#include <dwmapi.h>
#include <windows.h>
#include <windowsx.h>

// winuser.h aliases these names to IsIconic/IsZoomed. Keep Views declarations
// and calls independent of the Windows SDK's function-like macros.
#undef IsMinimized
#undef IsMaximized

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <set>
#include <utility>

#include "base/auto_reset.h"
#include "base/functional/bind.h"
#include "base/i18n/rtl.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/win/windows_version.h"
#include "cc/paint/paint_flags.h"
#include "ui/base/ime/input_method.h"
#include "ui/base/ime/text_input_client.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/models/combobox_model.h"
#include "ui/base/models/combobox_model_observer.h"
#include "ui/base/models/image_model.h"
#include "ui/color/color_id.h"
#include "ui/color/color_mixer.h"
#include "ui/color/color_provider.h"
#include "ui/color/color_provider_key.h"
#include "ui/color/color_recipe.h"
#include "ui/compositor/layer.h"
#include "ui/display/display.h"
#include "ui/display/screen.h"
#include "ui/events/event.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/color_utils.h"
#include "ui/gfx/font_list.h"
#include "ui/gfx/geometry/rect_conversions.h"
#include "ui/gfx/render_text.h"
#include "ui/gfx/selection_model.h"
#include "ui/gfx/shadow_value.h"
#include "ui/gfx/skia_paint_util.h"
#include "ui/native_theme/native_theme.h"
#include "ui/views/accessibility/view_accessibility.h"
#include "ui/views/background.h"
#include "ui/views/border.h"
#include "ui/views/controls/button/button.h"
#include "ui/views/controls/button/md_text_button.h"
#include "ui/views/controls/button/toggle_button.h"
#include "ui/views/controls/combobox/combobox.h"
#include "ui/views/controls/focus_ring.h"
#include "ui/views/controls/highlight_path_generator.h"
#include "ui/views/controls/image_view.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/link.h"
#include "ui/views/controls/progress_bar.h"
#include "ui/views/controls/scroll_view.h"
#include "ui/views/controls/scrollbar/base_scroll_bar_thumb.h"
#include "ui/views/controls/scrollbar/scroll_bar.h"
#include "ui/views/controls/separator.h"
#include "ui/views/controls/styled_label.h"
#include "ui/views/controls/textarea/textarea.h"
#include "ui/views/controls/textfield/textfield.h"
#include "ui/views/event_monitor.h"
#include "ui/views/focus/focus_manager.h"
#include "ui/views/layout/box_layout.h"
#include "ui/views/layout/fill_layout.h"
#include "ui/views/style/typography.h"
#include "ui/views/style/typography_provider.h"
#include "ui/views/view_class_properties.h"
#include "ui/views/view_tracker.h"
#include "ui/views/view_utils.h"
#include "ui/views/widget/desktop_aura/desktop_native_widget_aura.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/win/hwnd_util.h"

namespace electron {

namespace {

constexpr int kShadowInset = 14;
constexpr wchar_t kPanelProperty[] = L"Electron.NativePanel.Host";

base::DictValue RectValue(const gfx::Rect& bounds) {
  return base::DictValue()
      .Set("x", bounds.x())
      .Set("y", bounds.y())
      .Set("width", bounds.width())
      .Set("height", bounds.height());
}

std::string String(const base::DictValue& data,
                   std::string_view name,
                   std::string_view fallback = {}) {
  const std::string* value = data.FindString(name);
  return value ? *value : std::string(fallback);
}

int Integer(const base::DictValue& data, std::string_view key, int fallback) {
  if (auto value = data.FindInt(key))
    return *value;
  if (auto value = data.FindDouble(key))
    return static_cast<int>(*value);
  return fallback;
}

bool IsTextControl(std::string_view type) {
  return type == "input" || type == "textarea";
}

SkColor Color(const base::DictValue& theme,
              std::string_view name,
              SkColor fallback) {
  const std::string* value = theme.FindString(name);
  uint32_t result;
  if (!value || value->empty() || (*value)[0] != '#' ||
      !base::HexStringToUInt(value->substr(1), &result)) {
    return fallback;
  }
  return value->size() == 7 ? result | SK_ColorBLACK : result;
}

bool IsImeWindow(HWND window) {
  auto lower_ascii = [](std::wstring value) {
    std::transform(
        value.begin(), value.end(), value.begin(), [](wchar_t letter) {
          return letter >= L'A' && letter <= L'Z' ? letter + (L'a' - L'A')
                                                  : letter;
        });
    return value;
  };
  wchar_t class_name[256] = {};
  ::GetClassName(window, class_name, std::size(class_name));
  const std::wstring name = lower_ascii(std::wstring(class_name));
  if (name.find(L"ime") != std::wstring::npos ||
      name.find(L"candidate") != std::wstring::npos ||
      name.find(L"cicero") != std::wstring::npos)
    return true;
  // Modern Windows input methods can host candidates in a generic CoreWindow
  // or Xaml HWND. Check its owning process rather than trusting that generic
  // window class. This is only queried while one of our inputs is composing.
  DWORD process_id = 0;
  ::GetWindowThreadProcessId(window, &process_id);
  HANDLE process =
      ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id);
  if (!process)
    return false;
  wchar_t executable[MAX_PATH] = {};
  DWORD length = std::size(executable);
  bool queried = ::QueryFullProcessImageName(process, 0, executable, &length);
  ::CloseHandle(process);
  if (!queried)
    return false;
  const std::wstring path = lower_ascii(std::wstring(executable, length));
  return path.ends_with(L"\\textinputhost.exe") ||
         path.ends_with(L"\\inputapp.exe") || path.ends_with(L"\\ctfmon.exe");
}

// One observational hook is shared by all visible panels. It never consumes or
// synthesizes an event, including clicks on another process or transparent
// pixels. No hook is kept alive for hidden panels.
struct MouseMonitor {
  HHOOK hook = nullptr;
  std::set<NativePanelHost*> panels;
};

MouseMonitor& Monitor() {
  static base::NoDestructor<MouseMonitor> monitor;
  return *monitor;
}

LRESULT CALLBACK MouseProcedure(int code, WPARAM message, LPARAM parameter) {
  if (code == HC_ACTION &&
      (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN ||
       message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN)) {
    const auto& event = *reinterpret_cast<const MSLLHOOKSTRUCT*>(parameter);
    HWND target = ::WindowFromPoint(event.pt);
    for (NativePanelHost* panel : Monitor().panels)
      panel->OnGlobalMouseDown(gfx::Point(event.pt.x, event.pt.y), target);
  }
  return ::CallNextHookEx(nullptr, code, message, parameter);
}

void AddMouseMonitor(NativePanelHost* panel) {
  MouseMonitor& monitor = Monitor();
  monitor.panels.insert(panel);
  if (!monitor.hook) {
    monitor.hook = ::SetWindowsHookEx(WH_MOUSE_LL, MouseProcedure,
                                      ::GetModuleHandle(nullptr), 0);
  }
}

void RemoveMouseMonitor(NativePanelHost* panel) {
  MouseMonitor& monitor = Monitor();
  monitor.panels.erase(panel);
  if (monitor.panels.empty() && monitor.hook) {
    ::UnhookWindowsHookEx(monitor.hook);
    monitor.hook = nullptr;
  }
}

class PanelTheme final : public ui::ColorProviderKey::ThemeInitializerSupplier {
 public:
  explicit PanelTheme(const base::DictValue& theme)
      : ThemeInitializerSupplier(ThemeType::kAutogenerated) {
    auto assign = [&](const char* key, std::initializer_list<ui::ColorId> ids) {
      if (!theme.FindString(key))
        return;
      SkColor color = Color(theme, key, SK_ColorBLACK);
      for (ui::ColorId id : ids)
        colors_[id] = color;
    };
    assign("background",
           {ui::kColorTextfieldBackground, ui::kColorComboboxBackground,
            ui::kColorMenuBackground});
    assign("text", {ui::kColorTextfieldForeground, ui::kColorLabelForeground,
                    ui::kColorButtonForeground, ui::kColorMenuItemForeground});
    assign("muted", {ui::kColorTextfieldForegroundPlaceholder,
                     ui::kColorLabelForegroundSecondary,
                     ui::kColorMenuItemForegroundSecondary});
    assign("accent", {ui::kColorFocusableBorderFocused,
                      ui::kColorTextfieldSelectionBackground});
    assign("border",
           {ui::kColorTextfieldOutline, ui::kColorComboboxContainerOutline,
            ui::kColorFocusableBorderUnfocused, ui::kColorSeparator});
  }

  void AddColorMixers(ui::ColorProvider* provider,
                      const ui::ColorProviderKey& key) const override {
    auto& mixer = provider->AddMixer();
    for (const auto& [id, color] : colors_)
      mixer[id] = {color};
  }
  bool GetColor(int id, SkColor* color) const override {
    auto found = colors_.find(static_cast<ui::ColorId>(id));
    if (found == colors_.end())
      return false;
    *color = found->second;
    return true;
  }
  bool GetTint(int id, color_utils::HSL* hsl) const override { return false; }
  bool GetDisplayProperty(int id, int* result) const override { return false; }
  bool HasCustomImage(int id) const override { return false; }

 private:
  friend class base::RefCountedThreadSafe<PanelTheme>;
  ~PanelTheme() override = default;
  std::map<ui::ColorId, SkColor> colors_;
};

class PanelWidget final : public views::Widget {
 public:
  void SetPanelTheme(const base::DictValue& theme) {
    if (theme_ && theme == description_)
      return;
    description_ = theme.Clone();
    theme_ = base::MakeRefCounted<PanelTheme>(theme);
    std::string mode = String(theme, "mode", "system");
    SetColorModeOverride(
        mode == "system"
            ? std::nullopt
            : std::make_optional(
                  mode == "dark" ? ui::ColorProviderKey::ColorMode::kDark
                                 : ui::ColorProviderKey::ColorMode::kLight));
    ResetLastColorProviderKey();
    ThemeChanged();
  }

  ui::ColorProviderKey::ThemeInitializerSupplier* GetCustomTheme()
      const override {
    return theme_.get();
  }

 private:
  scoped_refptr<PanelTheme> theme_;
  base::DictValue description_;
};

class OptionModel final : public ui::ComboboxModel {
 public:
  void Update(const base::ListValue& items) {
    items_ = items.Clone();
    for (auto& observer : observers())
      observer.OnComboboxModelChanged(this);
  }
  size_t GetItemCount() const override { return items_.size(); }
  std::u16string GetItemAt(size_t index) const override {
    return base::UTF8ToUTF16(String(items_[index].GetDict(), "label"));
  }
  bool IsItemEnabledAt(size_t index) const override {
    return !items_[index].GetDict().FindBool("disabled").value_or(false);
  }
  std::optional<size_t> GetDefaultIndex() const override {
    for (size_t index = 0; index < items_.size(); ++index) {
      if (IsItemEnabledAt(index))
        return index;
    }
    // Combobox expects a selected index for any nonempty model, including a
    // completely disabled list. The disabled entries remain unselectable.
    return items_.empty() ? std::nullopt : std::make_optional<size_t>(0);
  }
  std::string ValueAt(size_t index) const {
    if (index >= items_.size())
      return {};
    const auto& item = items_[index].GetDict();
    return String(item, "value", String(item, "id"));
  }
  std::optional<size_t> IndexOf(const std::string& value) const {
    for (size_t index = 0; index < items_.size(); ++index) {
      if (ValueAt(index) == value && IsItemEnabledAt(index))
        return index;
    }
    return std::nullopt;
  }

 private:
  base::ListValue items_;
};

class PanelButton final : public views::MdTextButton {
 public:
  explicit PanelButton(PressedCallback callback)
      : MdTextButton(std::move(callback)), default_corners_(GetCornerRadii()) {
    label()->SetAutoColorReadabilityEnabled(false);
  }
  void SetPanelFont(const gfx::FontList& font) { label()->SetFontList(font); }
  void SetPlain(bool plain, const base::DictValue& style) {
    if (plain_ && !plain) {
      SetBgColorOverrideDeprecated(std::nullopt);
      SetStrokeColorOverrideDeprecated(std::nullopt);
      SetCustomPadding(std::nullopt);
      SetCornerRadii(default_corners_);
    }
    plain_ = plain;
    style_ = style.Clone();
    UpdateBackground();
  }

 private:
  void StateChanged(ButtonState old_state) override {
    MdTextButton::StateChanged(old_state);
    UpdateBackground();
  }
  void UpdateBackground() {
    SkColor background = Color(style_, "background", SK_ColorTRANSPARENT);
    if (GetState() == STATE_HOVERED)
      background =
          Color(style_, "hoverBackground",
                plain_ ? SkColorSetARGB(20, 128, 128, 128) : background);
    if (GetState() == STATE_PRESSED)
      background =
          Color(style_, "pressedBackground",
                plain_ ? SkColorSetARGB(35, 128, 128, 128) : background);
    if (GetState() == STATE_DISABLED)
      background = Color(style_, "disabledBackground", background);
    SetBgColorOverrideDeprecated(plain_ || style_.contains("background") ||
                                         style_.contains("hoverBackground") ||
                                         style_.contains("pressedBackground")
                                     ? std::optional<SkColor>(background)
                                     : std::nullopt);
    SetStrokeColorOverrideDeprecated(
        style_.contains("borderColor")
            ? std::optional<SkColor>(
                  Color(style_, "borderColor", SK_ColorTRANSPARENT))
        : plain_ ? std::optional<SkColor>(SK_ColorTRANSPARENT)
                 : std::nullopt);
    if (style_.contains("radius") || plain_)
      SetCornerRadius(Integer(style_, "radius", 8));
    else
      SetCornerRadii(default_corners_);
  }
  bool plain_ = false;
  base::DictValue style_;
  gfx::RoundedCornersF default_corners_;
};

// A width constraint must not freeze a multiline label or a container's
// unconstrained height. In particular, a root width is measured again after
// outer padding and a scrollbar reduce the actual available content width.
template <typename BaseView>
class DimensionedView final : public BaseView {
 public:
  void SetDimensions(int width, int height, int max_width = 0) {
    width_ = width;
    height_ = height;
    max_width_ = max_width;
    this->PreferredSizeChanged();
  }

  gfx::Size CalculatePreferredSize(
      const views::SizeBounds& available_size) const override {
    views::SizeBounds constrained(available_size);
    if (max_width_ > 0)
      constrained.set_width(
          available_size.width().is_bounded()
              ? std::min(max_width_, available_size.width().value())
              : max_width_);
    if (width_ > 0) {
      const int preferred_width =
          max_width_ > 0 ? std::min(width_, max_width_) : width_;
      constrained.set_width(
          available_size.width().is_bounded()
              ? std::min(preferred_width, available_size.width().value())
              : preferred_width);
    }
    gfx::Size size = BaseView::CalculatePreferredSize(constrained);
    if (width_ > 0)
      size.set_width(constrained.width().value());
    if (height_ > 0)
      size.set_height(height_);
    if (max_width_ > 0)
      size.set_width(std::min(size.width(), max_width_));
    return size;
  }

 private:
  int width_ = 0;
  int height_ = 0;
  int max_width_ = 0;
};

using PanelLabel = DimensionedView<views::Label>;
using PanelLinkedLabel = DimensionedView<views::StyledLabel>;
using PanelContainer = DimensionedView<views::View>;

class PanelScrollBar;

class PanelTextarea final : public views::Textarea,
                            private views::ScrollBarController {
 public:
  using KeyHandler =
      base::RepeatingCallback<bool(views::Textfield*, const ui::KeyEvent&)>;

  explicit PanelTextarea(KeyHandler key_handler);

  void SetAppearance(const base::DictValue& style);
  void SetScrollbarPlacement(const std::string& placement);
  void SyncScrollbar();
  bool OnMouseWheel(const ui::MouseWheelEvent& event) override;

  // RenderText normally scrolls the caret into view when fonts or bounds are
  // measured again. A cosmetic update must preserve a separately scrolled
  // editing viewport, including while an IME owns the selection.
  base::ScopedClosureRunner PreserveViewport() {
    return base::ScopedClosureRunner(base::BindOnce(
        [](base::WeakPtr<PanelTextarea> textarea, std::u16string text,
           gfx::SelectionModel selection, gfx::Vector2d offset) {
          if (textarea && textarea->GetText() == text &&
              textarea->GetSelectionModel() == selection) {
            textarea->GetRenderText()->SetDisplayOffset(offset);
            textarea->UpdateCursorViewPosition();
            textarea->UpdateCursorVisibility();
            textarea->SyncScrollbar();
            textarea->SchedulePaint();
          }
        },
        weak_factory_.GetWeakPtr(), std::u16string(GetText()),
        GetSelectionModel(), GetRenderText()->GetUpdatedDisplayOffset()));
  }

  void AppendState(base::DictValue* state);

 protected:
  void OnBoundsChanged(const gfx::Rect& previous_bounds) override;
  void OnDidSchedulePaint(const gfx::Rect& rect) override;

  bool PreHandleKeyPressed(const ui::KeyEvent& event) override {
    if (event.key_code() == ui::VKEY_RETURN) {
      // Textarea handles Return before TextfieldController. Give the host its
      // submit-on-Enter opportunity first, without turning IME confirmation
      // into either a submit or a new line.
      if (IsIMEComposing())
        return false;
      if (key_handler_.Run(this, event))
        return true;
    }
    return views::Textarea::PreHandleKeyPressed(event);
  }

 private:
  void ScrollToPosition(views::ScrollBar* source, int position) override;
  int GetScrollIncrement(views::ScrollBar* source,
                         bool is_page,
                         bool is_positive) override;
  void NotifyViewportChanged();

  bool custom_appearance_ = false;
  bool syncing_scrollbar_ = false;
  bool scrollbar_overflowing_ = false;
  bool measured_scrollbar_ = false;
  int border_width_ = 1;
  gfx::Rect measured_viewport_;
  std::u16string measured_text_;
  std::string measured_font_;
  raw_ptr<PanelScrollBar> scrollbar_ = nullptr;
  KeyHandler key_handler_;
  base::WeakPtrFactory<PanelTextarea> weak_factory_{this};
};

// A real native Button with arbitrary native child views. Child buttons remain
// independent event targets; there is no DOM-style bubbling to this row.
class PanelAction final : public views::Button {
 public:
  explicit PanelAction(PressedCallback callback) : Button(std::move(callback)) {
    SetFocusBehavior(FocusBehavior::ALWAYS);
    // Rows can fill a clipped ScrollView. Keep the native focus outline inside
    // the action instead of allowing its default outset to lose both sides.
    auto* ring = views::FocusRing::Get(this);
    ring->SetOutsetFocusRingDisabled(true);
    ring->SetHaloInset(1.f);
    SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal));
  }
  bool OnMousePressed(const ui::MouseEvent& event) override {
    if (row_ && GetWidget() && GetWidget()->CanActivate())
      RequestFocus();
    return Button::OnMousePressed(event);
  }
  void SetRow(bool row) { row_ = row; }
  void SetAppearance(const base::DictValue& style,
                     bool selected,
                     SkColor hover) {
    style_ = style.Clone();
    selected_ = selected;
    hover_ = hover;
    const int radius = Integer(style_, "radius", 8);
    if (focus_radius_ != radius) {
      focus_radius_ = radius;
      views::FocusRing::Get(this)->SetPathGenerator(
          std::make_unique<views::RoundRectHighlightPathGenerator>(
              gfx::Insets(), radius));
    }
    SchedulePaint();
  }

 private:
  void StateChanged(ButtonState old_state) override {
    Button::StateChanged(old_state);
    SchedulePaint();
  }
  void OnFocus() override {
    Button::OnFocus();
    SchedulePaint();
  }
  void OnBlur() override {
    Button::OnBlur();
    SchedulePaint();
  }
  void OnPaintBackground(gfx::Canvas* canvas) override {
    SkColor background = Color(style_, "background", SK_ColorTRANSPARENT);
    if (selected_ || HasFocus())
      background = Color(style_, "selectedBackground", hover_);
    if (GetState() == STATE_HOVERED)
      background = Color(style_, "hoverBackground", hover_);
    if (GetState() == STATE_PRESSED)
      background = Color(style_, "pressedBackground", hover_);
    if (!GetEnabled())
      background = Color(style_, "disabledBackground", SK_ColorTRANSPARENT);
    cc::PaintFlags flags;
    flags.setAntiAlias(true);
    flags.setColor(background);
    const int radius = Integer(style_, "radius", 8);
    canvas->DrawRoundRect(GetLocalBounds(), radius, flags);
    const int stroke = Integer(style_, "borderWidth", 0);
    if (stroke) {
      flags.setStyle(cc::PaintFlags::kStroke_Style);
      flags.setStrokeWidth(stroke);
      flags.setColor(Color(style_, "borderColor", SK_ColorTRANSPARENT));
      gfx::RectF bounds(GetLocalBounds());
      bounds.Inset(stroke / 2.f);
      canvas->DrawRoundRect(bounds, radius, flags);
    }
  }
  base::DictValue style_;
  bool selected_ = false;
  bool row_ = false;
  SkColor hover_ = SK_ColorTRANSPARENT;
  int focus_radius_ = -1;
};

gfx::Insets ControlInsets(const base::DictValue& style, int fallback = 0) {
  return gfx::Insets::TLBR(Integer(style, "paddingTop", fallback),
                           Integer(style, "paddingLeft", fallback),
                           Integer(style, "paddingBottom", fallback),
                           Integer(style, "paddingRight", fallback));
}

void PanelTextarea::SetAppearance(const base::DictValue& style) {
  const bool borderless = style.FindBool("borderless").value_or(false);
  const bool custom =
      borderless || style.contains("background") ||
      style.contains("borderColor") || style.contains("borderWidth") ||
      style.contains("radius") || style.contains("paddingTop") ||
      style.contains("paddingRight") || style.contains("paddingBottom") ||
      style.contains("paddingLeft");
  if (!custom && !custom_appearance_)
    return;
  custom_appearance_ = custom;
  SetBackgroundEnabled(true);
  if (!custom) {
    border_width_ = 1;
    SetUseDefaultBorder(true);
    SetCornerRadius(std::nullopt);
    // SetUseDefaultBorder only flips a flag. Refresh the default native border
    // even when the corner radius was already unset, then restore its ring.
    SetExtraInsets(gfx::Insets());
    SetBackgroundColor(std::nullopt);
    views::FocusRing::Install(this);
  } else {
    SetCornerRadius(style.contains("radius")
                        ? std::make_optional<float>(Integer(style, "radius", 0))
                        : std::nullopt);
    const int stroke = borderless ? 0 : Integer(style, "borderWidth", 1);
    border_width_ = stroke;
    const gfx::Insets padding = ControlInsets(style, borderless ? 2 : 6);
    SetBorder(stroke > 0 ? views::CreatePaddedBorder(
                               views::CreateRoundedRectBorder(
                                   stroke, GetCornerRadius(),
                                   Color(style, "borderColor",
                                         GetColorProvider()->GetColor(
                                             ui::kColorTextfieldOutline))),
                               padding)
                         : views::CreateEmptyBorder(padding));
    // Textfield's own painter uses GetCornerRadius(), so opaque backgrounds
    // respect the rounded border instead of filling the transparent corners.
    // Keeping it enabled also preserves native text/placeholder antialiasing.
    SetBackgroundColor(
        style.contains("background")
            ? std::optional<ui::ColorVariant>(
                  Color(style, "background", SK_ColorTRANSPARENT))
        : borderless ? std::optional<ui::ColorVariant>(SK_ColorTRANSPARENT)
                     : std::nullopt);
  }
  // A fixed-size textarea can change padding without changing its bounds.
  // Recompute RenderText's viewport immediately in that case as well.
  FitToLocalBounds();
  SyncScrollbar();
}

int ScrollPosition(views::ScrollView* scroll) {
  return scroll->CurrentOffset().y();
}

constexpr int kPanelScrollbarWidth = 12;

SkColor ScrollbarColor(views::View* view,
                       bool track,
                       views::Button::ButtonState state) {
  const auto* colors = view->GetColorProvider();
  const SkColor background = colors->GetColor(ui::kColorMenuBackground);
  if (view->GetNativeTheme()->forced_colors() !=
      ui::ColorProviderKey::ForcedColors::kNone) {
    return colors->GetColor(track ? ui::kColorCssSystemWindow
                            : state == views::Button::STATE_NORMAL
                                ? ui::kColorCssSystemWindowText
                                : ui::kColorCssSystemHighlight);
  }
  const bool dark = color_utils::GetRelativeLuminance(background) < 0.5;
  if (track)
    return state == views::Button::STATE_NORMAL ? SK_ColorTRANSPARENT
           : dark ? SkColorSetARGB(16, 255, 255, 255)
                  : SkColorSetARGB(10, 0, 0, 0);
  if (state == views::Button::STATE_PRESSED)
    return dark ? SkColorSetARGB(210, 255, 255, 255)
                : SkColorSetARGB(180, 0, 0, 0);
  if (state == views::Button::STATE_HOVERED)
    return dark ? SkColorSetARGB(170, 255, 255, 255)
                : SkColorSetARGB(140, 0, 0, 0);
  return dark ? SkColorSetARGB(110, 255, 255, 255)
              : SkColorSetARGB(90, 0, 0, 0);
}

class PanelScrollThumb final : public views::BaseScrollBarThumb {
  METADATA_HEADER(PanelScrollThumb, views::BaseScrollBarThumb)

 public:
  explicit PanelScrollThumb(views::ScrollBar* bar)
      : BaseScrollBarThumb(bar), bar_(bar) {
    SetSnapBackOnDragOutside(false);
  }
  gfx::Size CalculatePreferredSize(const views::SizeBounds&) const override {
    return gfx::Size(kPanelScrollbarWidth,
                     std::min(24, bar_->GetTrackBounds().height()));
  }
  views::Button::ButtonState VisualState() const { return GetState(); }
  gfx::RectF PaintBounds() const {
    const bool forced = GetNativeTheme()->forced_colors() !=
                        ui::ColorProviderKey::ForcedColors::kNone;
    const int thickness =
        forced || GetState() != views::Button::STATE_NORMAL ? 6 : 4;
    gfx::RectF bounds(GetLocalBounds());
    bounds.Inset(gfx::InsetsF::VH(0, (width() - thickness) / 2.f));
    return bounds;
  }
  gfx::Rect PaintBoundsInScreen() const {
    gfx::Rect bounds = gfx::ToEnclosingRect(PaintBounds());
    ConvertRectToScreen(this, &bounds);
    return bounds;
  }

 protected:
  void OnPaint(gfx::Canvas* canvas) override {
    cc::PaintFlags paint;
    paint.setAntiAlias(true);
    paint.setColor(ScrollbarColor(this, false, GetState()));
    const gfx::RectF bounds = PaintBounds();
    canvas->DrawRoundRect(bounds, bounds.width() / 2, paint);
  }

 private:
  raw_ptr<views::ScrollBar> bar_;
};

BEGIN_METADATA(PanelScrollThumb)
END_METADATA

class PanelScrollBar final : public views::ScrollBar {
  METADATA_HEADER(PanelScrollBar, views::ScrollBar)

 public:
  PanelScrollBar() : ScrollBar(Orientation::kVertical) {
    SetNotifyEnterExitOnChild(true);
    SetThumb(new PanelScrollThumb(this));
  }
  void SetPlacement(std::string_view placement) {
    if (placement_ == placement)
      return;
    placement_ = placement;
    if (parent())
      parent()->InvalidateLayout();
    PreferredSizeChanged();
    SchedulePaint();
  }
  const std::string& placement() const { return placement_; }
  bool OverlapsContent() const override { return placement_ == "overlay"; }
  int GetThickness() const override { return kPanelScrollbarWidth; }
  gfx::Rect GetTrackBounds() const override {
    gfx::Rect bounds = GetLocalBounds();
    bounds.Inset(gfx::Insets::VH(std::min(2, height() / 2), 0));
    return bounds;
  }
  void Update(int viewport_size,
              int content_size,
              int contents_scroll_offset) override {
    viewport_size_ = viewport_size;
    content_size_ = content_size;
    contents_offset_ = std::clamp(contents_scroll_offset, 0,
                                  std::max(0, content_size - viewport_size));
    ScrollBar::Update(viewport_size, content_size, contents_offset_);
  }
  base::DictValue GetState() const {
    gfx::Rect track = GetTrackBounds();
    ConvertRectToScreen(this, &track);
    const auto* thumb = static_cast<PanelScrollThumb*>(GetThumb());
    return base::DictValue()
        .Set("bounds", RectValue(GetBoundsInScreen()))
        .Set("track", RectValue(track))
        .Set("thumb", RectValue(GetThumb()->GetBoundsInScreen()))
        .Set("thumbPaintBounds", RectValue(thumb->PaintBoundsInScreen()))
        .Set("visible", GetVisible())
        .Set("placement", placement_)
        .Set("hovered", IsMouseHovered())
        .Set("pressed", thumb->VisualState() == views::Button::STATE_PRESSED)
        .Set("position", contents_offset_)
        .Set("maximum", GetMaxPosition());
  }

 protected:
  void OnPaint(gfx::Canvas* canvas) override {
    const SkColor color =
        ScrollbarColor(this, true,
                       IsMouseHovered() ? views::Button::STATE_HOVERED
                                        : views::Button::STATE_NORMAL);
    if (SkColorGetA(color))
      canvas->FillRect(GetLocalBounds(), color);
  }
  void OnMouseEntered(const ui::MouseEvent& event) override {
    ScrollBar::OnMouseEntered(event);
    SchedulePaint();
  }
  void OnMouseExited(const ui::MouseEvent& event) override {
    ScrollBar::OnMouseExited(event);
    SchedulePaint();
  }
  void OnBoundsChanged(const gfx::Rect& previous_bounds) override {
    ScrollBar::OnBoundsChanged(previous_bounds);
    Update(viewport_size_, content_size_, contents_offset_);
  }
  void ScrollToPosition(int position) override {
    contents_offset_ = position;
    ScrollBar::ScrollToPosition(position);
  }

 private:
  int viewport_size_ = 0;
  int content_size_ = 0;
  int contents_offset_ = 0;
  std::string placement_ = "gutter";
};

BEGIN_METADATA(PanelScrollBar)
END_METADATA

PanelTextarea::PanelTextarea(KeyHandler key_handler)
    : key_handler_(std::move(key_handler)) {
  scrollbar_ = AddChildView(std::make_unique<PanelScrollBar>());
  scrollbar_->set_controller(this);
  scrollbar_->SetVisible(false);
}

void PanelTextarea::SetScrollbarPlacement(const std::string& placement) {
  scrollbar_->SetPlacement(placement);
  SyncScrollbar();
}

void PanelTextarea::SyncScrollbar() {
  if (!scrollbar_ || syncing_scrollbar_ || GetLocalBounds().IsEmpty())
    return;
  base::AutoReset<bool> syncing(&syncing_scrollbar_, true);
  gfx::RenderText* render = GetRenderText();
  const gfx::Rect previous_viewport = render->display_rect();
  const gfx::Vector2d previous_offset = render->GetUpdatedDisplayOffset();
  gfx::Rect full = GetLocalBounds();
  full.Inset(GetInsets());
  full.set_x(GetMirroredXForRect(full));
  const auto& fonts = GetFontList();
  const std::string font =
      fonts.GetPrimaryFont().GetFontName() + "/" +
      std::to_string(fonts.GetFontSize()) + "/" +
      std::to_string(fonts.GetFontStyle()) + "/" +
      std::to_string(static_cast<int>(fonts.GetFontWeight()));
  // Cursor blinking and thumb hover also schedule paints. Measure the wider
  // unscrolled text only when its content, font, or available space changed.
  if (!measured_scrollbar_ || measured_viewport_ != full ||
      measured_text_ != GetText() || measured_font_ != font) {
    render->SetDisplayRect(full);
    scrollbar_overflowing_ = render->GetStringSize().height() > full.height();
    measured_scrollbar_ = true;
    measured_viewport_ = full;
    measured_text_ = GetText();
    measured_font_ = font;
  }
  // The scrollbar belongs to the editor's visual edge, independently of the
  // text padding. Gutter mode reserves only the space needed to avoid it.
  gfx::Rect bar_area = GetLocalBounds();
  bar_area.Inset(gfx::Insets(border_width_ + 2));
  const int gutter = std::min(kPanelScrollbarWidth, bar_area.width());
  const gfx::Rect bar_bounds(bar_area.right() - gutter, bar_area.y(), gutter,
                             bar_area.height());
  gfx::Rect viewport = full;
  if (scrollbar_overflowing_ && !scrollbar_->OverlapsContent()) {
    viewport.set_width(std::max(
        0, std::min(viewport.right(), bar_bounds.x() - 2) - viewport.x()));
  }
  render->SetDisplayRect(viewport);
  if (viewport == previous_viewport)
    render->SetDisplayOffset(previous_offset);
  const gfx::Vector2d offset = render->GetUpdatedDisplayOffset();
  scrollbar_->SetBoundsRect(bar_bounds);
  scrollbar_->SetVisible(scrollbar_overflowing_);
  scrollbar_->Update(viewport.height(), render->GetStringSize().height(),
                     -offset.y());
  GetViewAccessibility().SetScrollYMin(0);
  GetViewAccessibility().SetScrollYMax(scrollbar_->GetMaxPosition());
  if (viewport != previous_viewport || offset != previous_offset)
    NotifyViewportChanged();
}

void PanelTextarea::NotifyViewportChanged() {
  UpdateCursorViewPosition();
  UpdateCursorVisibility();
  GetViewAccessibility().SetScrollY(
      -GetRenderText()->GetUpdatedDisplayOffset().y());
  if (auto* method = GetInputMethod())
    method->OnCaretBoundsChanged(this);
}

bool PanelTextarea::OnMouseWheel(const ui::MouseWheelEvent& event) {
  const bool handled = views::Textarea::OnMouseWheel(event);
  SyncScrollbar();
  NotifyViewportChanged();
  return handled;
}

void PanelTextarea::OnBoundsChanged(const gfx::Rect& previous_bounds) {
  views::Textarea::OnBoundsChanged(previous_bounds);
  SyncScrollbar();
}

void PanelTextarea::OnDidSchedulePaint(const gfx::Rect& rect) {
  views::Textarea::OnDidSchedulePaint(rect);
  SyncScrollbar();
}

void PanelTextarea::ScrollToPosition(views::ScrollBar* source, int position) {
  gfx::RenderText* render = GetRenderText();
  render->SetDisplayOffset(
      gfx::Vector2d(render->GetUpdatedDisplayOffset().x(), -position));
  SyncScrollbar();
  NotifyViewportChanged();
  SchedulePaint();
}

int PanelTextarea::GetScrollIncrement(views::ScrollBar* source,
                                      bool is_page,
                                      bool is_positive) {
  const int line = std::max(1, GetFontList().GetHeight());
  return is_page
             ? std::max(line, GetRenderText()->display_rect().height() - line)
             : line;
}

void PanelTextarea::AppendState(base::DictValue* state) {
  SyncScrollbar();
  const gfx::Vector2d offset = GetRenderText()->GetUpdatedDisplayOffset();
  gfx::Rect viewport = GetRenderText()->display_rect();
  ConvertRectToScreen(this, &viewport);
  state->Set("lineCount", static_cast<int>(GetNumLines()));
  state->Set("displayOffset",
             base::DictValue().Set("x", offset.x()).Set("y", offset.y()));
  state->Set("viewportBounds", RectValue(viewport));
  const gfx::Insets insets = GetInsets();
  state->Set("contentInsets", base::DictValue()
                                  .Set("top", insets.top())
                                  .Set("right", insets.right())
                                  .Set("bottom", insets.bottom())
                                  .Set("left", insets.left()));
  state->Set("scrollbar", scrollbar_->GetState());
  state->Set("scrollbarPlacement", scrollbar_->placement());
}

}  // namespace

class NativePanelSurface final : public views::View {
 public:
  explicit NativePanelSurface(bool shadow_only = false)
      : shadow_only_(shadow_only) {
    SetLayoutManager(std::make_unique<views::FillLayout>());
  }
  void SetAppearance(const base::DictValue& theme,
                     int radius,
                     bool shadow,
                     int content_inset) {
    theme_ = theme.Clone();
    radius_ = radius;
    shadow_ = shadow;
    SetBorder(views::CreateEmptyBorder(
        gfx::Insets(content_inset + (shadow ? kShadowInset : 0))));
    SchedulePaint();
  }
  gfx::Rect BodyBounds() const {
    gfx::Rect bounds = GetLocalBounds();
    bounds.Inset(shadow_ ? kShadowInset : 0);
    return bounds;
  }
  void SetAcrylicApplied(bool applied, bool requested) {
    const bool fallback = requested && !applied;
    if (acrylic_applied_ == applied && opaque_material_fallback_ == fallback)
      return;
    acrylic_applied_ = applied;
    opaque_material_fallback_ = fallback;
    SchedulePaint();
  }
  bool ContainsBodyPoint(gfx::Point point) const {
    const gfx::Rect body = BodyBounds();
    if (!body.Contains(point))
      return false;
    const double radius = std::min({static_cast<double>(radius_),
                                    body.width() / 2.0, body.height() / 2.0});
    const double x = point.x() + 0.5;
    const double y = point.y() + 0.5;
    const double cx = std::clamp(x, body.x() + radius, body.right() - radius);
    const double cy = std::clamp(y, body.y() + radius, body.bottom() - radius);
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius;
  }

 private:
  void OnPaintBackground(gfx::Canvas* canvas) override {
    const bool dark =
        color_utils::GetRelativeLuminance(
            GetColorProvider()->GetColor(ui::kColorMenuBackground)) < 0.5;
    SkColor background =
        Color(theme_, "background",
              GetColorProvider()->GetColor(ui::kColorMenuBackground));
    if (opaque_material_fallback_)
      background = SkColorSetA(background, SK_AlphaOPAQUE);
    const SkColor border =
        Color(theme_, "border", dark ? 0xff555555 : 0xffdadce0);
    cc::PaintFlags fill;
    fill.setAntiAlias(true);
    fill.setColor(background);
    if (shadow_ && shadow_only_) {
      fill.setLooper(gfx::CreateShadowDrawLooper(
          {gfx::ShadowValue(gfx::Vector2d(0, 3), 12, 0x50000000)}));
    }
    if (shadow_only_) {
      canvas->DrawRoundRect(BodyBounds(), radius_, fill);
      // A solid body in this separate HWND would hide the host from DWM's
      // backdrop sampler. Keep only its input-transparent exterior shadow.
      fill.setLooper(nullptr);
      fill.setBlendMode(SkBlendMode::kClear);
      canvas->DrawRoundRect(BodyBounds(), radius_, fill);
      return;
    }
    if (!acrylic_applied_)
      canvas->DrawRoundRect(BodyBounds(), radius_, fill);
    cc::PaintFlags stroke;
    stroke.setAntiAlias(true);
    stroke.setColor(border);
    stroke.setStyle(cc::PaintFlags::kStroke_Style);
    stroke.setStrokeWidth(1);
    gfx::RectF rect(BodyBounds());
    rect.Inset(0.5f);
    canvas->DrawRoundRect(rect, radius_, stroke);
  }
  base::DictValue theme_;
  int radius_ = 12;
  bool shadow_ = true;
  bool acrylic_applied_ = false;
  bool opaque_material_fallback_ = false;
  const bool shadow_only_;
};

struct NativePanelHost::Entry {
  views::View* FocusTarget() const {
    if (linked_label)
      for (views::View* child : linked_label->children())
        if (views::IsViewClass<views::Link>(child))
          return child;
    return control;
  }
  std::string id;
  std::string type;
  std::string parent_id;
  base::DictValue properties;
  raw_ptr<views::View> view = nullptr;
  raw_ptr<views::View> children = nullptr;
  raw_ptr<views::View> control = nullptr;
  raw_ptr<views::Label> label = nullptr;
  raw_ptr<views::StyledLabel> linked_label = nullptr;
  base::DictValue linked_appearance;
  raw_ptr<views::ScrollView> scroll = nullptr;
  raw_ptr<views::ImageView> image = nullptr;
  std::unique_ptr<OptionModel> model;
  std::optional<std::u16string> pending_input;
};

NativePanelNode::NativePanelNode() = default;
NativePanelNode::NativePanelNode(NativePanelNode&&) = default;
NativePanelNode& NativePanelNode::operator=(NativePanelNode&&) = default;
NativePanelNode::~NativePanelNode() = default;
NativePanelOptions::NativePanelOptions() = default;
NativePanelOptions::NativePanelOptions(NativePanelOptions&&) = default;
NativePanelOptions::~NativePanelOptions() = default;

NativePanelHost::NativePanelHost(views::Widget* parent,
                                 NativePanelOptions options,
                                 ActionCallback action,
                                 DismissCallback dismissed,
                                 base::RepeatingClosure closed)
    : parent_(parent),
      restore_focus_(std::make_unique<views::ViewTracker>()),
      options_(std::move(options)),
      action_(std::move(action)),
      dismissed_(std::move(dismissed)),
      closed_(std::move(closed)) {
  delegate_ = std::make_unique<views::WidgetDelegate>();
  delegate_->SetCanActivate(options_.focus_mode != "none");
  delegate_->SetShowTitle(false);
  delegate_->SetShowCloseButton(false);
  delegate_->SetEnableArrowKeyTraversal(options_.focus_mode == "menu");
  delegate_->set_use_desktop_widget_override(true);
  auto surface = std::make_unique<NativePanelSurface>();
  surface_ = surface.get();
  surface_->AddPreTargetHandler(this);
  auto scroll = std::make_unique<views::ScrollView>();
  outer_scroll_ = scroll.get();
  auto scrollbar = std::make_unique<PanelScrollBar>();
  scrollbar->SetPlacement(options_.scrollbar_placement);
  scroll->SetVerticalScrollBar(std::move(scrollbar));
  scroll->SetPaintToLayer();
  scroll->layer()->SetFillsBoundsOpaquely(false);
  scroll->layer()->SetMasksToBounds(true);
  scroll->SetDrawOverflowIndicator(false);
  scroll->SetBackgroundColor(std::nullopt);
  scroll->SetHorizontalScrollBarMode(
      views::ScrollView::ScrollBarMode::kDisabled);
  auto contents = std::make_unique<views::View>();
  content_container_ = contents.get();
  contents->SetLayoutManager(std::make_unique<views::FillLayout>());
  scroll->SetContents(std::move(contents));
  surface_->AddChildView(std::move(scroll));
  delegate_->SetContentsView(std::move(surface));
  auto widget = std::make_unique<PanelWidget>();
  widget_ = std::move(widget);
  views::Widget::InitParams params(
      views::Widget::InitParams::CLIENT_OWNS_WIDGET,
      views::Widget::InitParams::TYPE_POPUP);
  params.delegate = delegate_.get();
  params.SetParent(parent_);
  // Electron's ViewsDelegate otherwise chooses an embedded NativeWidgetAura
  // for a TYPE_POPUP with a parent, ignoring the delegate's desktop override.
  // Supply the desktop implementation explicitly so this widget owns a HWND.
  params.native_widget = new views::DesktopNativeWidgetAura(widget_.get());
  params.child = false;
  params.name = "ElectronNativePanel";
  params.opacity = views::Widget::InitParams::WindowOpacity::kTranslucent;
  params.activatable = options_.focus_mode == "none"
                           ? views::Widget::InitParams::Activatable::kNo
                           : views::Widget::InitParams::Activatable::kYes;
  // The surface paints its own shadow. Its alpha pixels and rounded corners
  // are excluded in WM_NCHITTEST without clipping the visible surface.
  params.shadow_type = views::Widget::InitParams::ShadowType::kNone;
  params.remove_standard_frame = true;
  widget_->Init(std::move(params));
  widget_->AddObserver(this);
  parent_->AddObserver(this);
  parent_bounds_ = parent_->GetWindowBoundsInScreen();
  HWND native_window = views::HWNDForWidget(widget_.get());
  HWND parent_window = views::HWNDForWidget(parent_);
  native_windows_valid_ =
      native_window && native_window != parent_window &&
      ::GetAncestor(native_window, GA_ROOT) == native_window &&
      ::GetWindow(native_window, GW_OWNER) == parent_window;
  // Never apply a region or extended style to the owner's HWND if a platform
  // implementation regresses to embedding this widget in the owner's host.
  if (!native_windows_valid_)
    return;
  InstallWindowHook();
  ApplyTheme();
  if (!native_windows_valid_)
    return;
  UpdateContent(std::move(options_.content));
}

NativePanelHost::~NativePanelHost() {
  Destroy();
}

void NativePanelHost::EnsureShadowWindow() {
  if (!options_.shadow) {
    shadow_widget_.reset();
    shadow_delegate_.reset();
    shadow_surface_ = nullptr;
    return;
  }
  if (shadow_widget_ || !parent_)
    return;
  shadow_delegate_ = std::make_unique<views::WidgetDelegate>();
  shadow_delegate_->SetCanActivate(false);
  shadow_delegate_->SetShowTitle(false);
  shadow_delegate_->SetShowCloseButton(false);
  shadow_delegate_->set_use_desktop_widget_override(true);
  auto surface = std::make_unique<NativePanelSurface>(true);
  shadow_surface_ = surface.get();
  shadow_delegate_->SetContentsView(std::move(surface));
  shadow_widget_ = std::make_unique<PanelWidget>();
  views::Widget::InitParams params(
      views::Widget::InitParams::CLIENT_OWNS_WIDGET,
      views::Widget::InitParams::TYPE_POPUP);
  params.delegate = shadow_delegate_.get();
  params.SetParent(parent_);
  params.native_widget =
      new views::DesktopNativeWidgetAura(shadow_widget_.get());
  params.child = false;
  params.name = "ElectronNativePanelShadow";
  params.opacity = views::Widget::InitParams::WindowOpacity::kTranslucent;
  params.activatable = views::Widget::InitParams::Activatable::kNo;
  params.accept_events = false;
  params.shadow_type = views::Widget::InitParams::ShadowType::kNone;
  params.remove_standard_frame = true;
  shadow_widget_->Init(std::move(params));
  HWND shadow_window = views::HWNDForWidget(shadow_widget_.get());
  HWND parent_window = views::HWNDForWidget(parent_);
  if (!shadow_window || shadow_window == parent_window ||
      shadow_window == hwnd_ ||
      ::GetAncestor(shadow_window, GA_ROOT) != shadow_window ||
      ::GetWindow(shadow_window, GW_OWNER) != parent_window) {
    native_windows_valid_ = false;
    shadow_widget_.reset();
    shadow_delegate_.reset();
    shadow_surface_ = nullptr;
    return;
  }
  LONG_PTR styles = ::GetWindowLongPtr(shadow_window, GWL_EXSTYLE);
  ::SetWindowLongPtr(shadow_window, GWL_EXSTYLE,
                     (styles | WS_EX_LAYERED | WS_EX_TRANSPARENT |
                      WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) &
                         ~WS_EX_APPWINDOW);
}

void NativePanelHost::UpdateInputRegion() {
  if (!hwnd_ || !::IsWindow(hwnd_) || applying_input_region_)
    return;
  base::AutoReset<bool> applying_region(&applying_input_region_, true);
  RECT client;
  ::GetClientRect(hwnd_, &client);
  const double scale =
      surface_->width() > 0
          ? static_cast<double>(client.right) / surface_->width()
          : 1.0;
  const int inset = std::round((options_.shadow ? kShadowInset : 0) * scale);
  const gfx::Rect bounds(inset, inset, std::max(0L, client.right - 2 * inset),
                         std::max(0L, client.bottom - 2 * inset));
  const int radius =
      std::min({static_cast<int>(std::round(options_.radius * scale)),
                bounds.width() / 2, bounds.height() / 2});
  HRGN region =
      radius > 0 ? ::CreateRoundRectRgn(bounds.x(), bounds.y(), bounds.right(),
                                        bounds.bottom(), 2 * radius, 2 * radius)
                 : ::CreateRectRgn(bounds.x(), bounds.y(), bounds.right(),
                                   bounds.bottom());
  // Excluding non-body pixels from the native region lets Windows hit-test
  // directly against lower windows even when they belong to another process.
  // Visible shadows live in a separate, wholly input-transparent layered HWND.
  if (!::SetWindowRgn(hwnd_, region, visible_)) {
    ::DeleteObject(region);
  }
}

void NativePanelHost::InstallWindowHook() {
  hwnd_ = views::HWNDForWidget(widget_.get());
  ::SetProp(hwnd_, kPanelProperty, reinterpret_cast<HANDLE>(this));
  previous_window_proc_ = reinterpret_cast<WNDPROC>(::SetWindowLongPtr(
      hwnd_, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&WindowProcedure)));
  LONG_PTR style = ::GetWindowLongPtr(hwnd_, GWL_EXSTYLE);
  ::SetWindowLongPtr(hwnd_, GWL_EXSTYLE,
                     (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW);
}

void NativePanelHost::RemoveWindowHook() {
  if (hwnd_ && ::IsWindow(hwnd_)) {
    if (previous_window_proc_)
      ::SetWindowLongPtr(hwnd_, GWLP_WNDPROC,
                         reinterpret_cast<LONG_PTR>(previous_window_proc_));
    ::RemoveProp(hwnd_, kPanelProperty);
  }
  previous_window_proc_ = nullptr;
  hwnd_ = nullptr;
}

LRESULT CALLBACK NativePanelHost::WindowProcedure(HWND window,
                                                  UINT message,
                                                  WPARAM wparam,
                                                  LPARAM lparam) {
  auto* self =
      reinterpret_cast<NativePanelHost*>(::GetProp(window, kPanelProperty));
  if (!self || !self->previous_window_proc_)
    return ::DefWindowProc(window, message, wparam, lparam);
  WNDPROC previous = self->previous_window_proc_;
  if (message == WM_NCHITTEST &&
      !self->HitTestScreenPoint({GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)})) {
    return HTTRANSPARENT;
  }
  auto weak_self = self->weak_factory_.GetWeakPtr();
  LRESULT result = ::CallWindowProc(previous, window, message, wparam, lparam);
  // HWNDMessageHandler can reset native regions after its WM_SIZE work. Apply
  // our body region after that pass as well as after each requested layout.
  if (weak_self && (message == WM_SIZE || message == WM_DPICHANGED ||
                    message == WM_THEMECHANGED))
    weak_self->UpdateInputRegion();
  if (weak_self && !weak_self->destroying_ &&
      (message == WM_SETTINGCHANGE || message == WM_THEMECHANGED ||
       message == WM_DWMCOMPOSITIONCHANGED || message == WM_POWERBROADCAST)) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::WeakPtr<NativePanelHost> host) {
                         if (host && !host->destroying_ && host->widget_) {
                           host->material_system_configuration_.clear();
                           host->ApplyTheme();
                         }
                       },
                       weak_self));
  }
  return result;
}

bool NativePanelHost::HitTestScreenPoint(gfx::Point screen_point) const {
  if (!surface_ || !hwnd_)
    return false;
  POINT point{screen_point.x(), screen_point.y()};
  ::ScreenToClient(hwnd_, &point);
  RECT physical;
  ::GetClientRect(hwnd_, &physical);
  const double scale =
      physical.right > 0 && surface_->width() > 0
          ? static_cast<double>(physical.right) / surface_->width()
          : 1.0;
  return surface_->ContainsBodyPoint(
      gfx::Point(std::floor(point.x / scale), std::floor(point.y / scale)));
}

std::unique_ptr<views::View> NativePanelHost::CreateControl(
    const NativePanelNode& node,
    Entry* entry) {
  auto callback = base::BindRepeating(
      &NativePanelHost::SendAction, weak_factory_.GetWeakPtr(), node.id,
      (node.type == "button" || node.type == "iconButton" ||
       node.type == "item")
          ? "click"
          : "change");
  std::unique_ptr<views::View> result;
  if (node.type == "text") {
    if (node.properties.contains("linkRange")) {
      auto label = std::make_unique<PanelLinkedLabel>();
      label->SetAutoColorReadabilityEnabled(false);
      label->SetSubpixelRenderingEnabled(false);
      entry->linked_label = label.get();
      result = std::move(label);
    } else {
      auto label = std::make_unique<PanelLabel>();
      label->SetHorizontalAlignment(gfx::ALIGN_LEFT);
      label->SetMultiLine(true);
      label->SetSubpixelRenderingEnabled(false);
      label->SetAutoColorReadabilityEnabled(false);
      entry->label = label.get();
      result = std::move(label);
    }
  } else if (node.type == "icon") {
    result = std::make_unique<views::ImageView>();
  } else if (node.type == "button") {
    result = std::make_unique<PanelButton>(std::move(callback));
  } else if (node.type == "item" || node.type == "iconButton") {
    auto action = std::make_unique<PanelAction>(std::move(callback));
    action->SetRow(node.type == "item");
    if (node.type == "item") {
      entry->children = action.get();
    } else {
      auto* layout = static_cast<views::BoxLayout*>(action->GetLayoutManager());
      layout->set_main_axis_alignment(
          views::BoxLayout::MainAxisAlignment::kCenter);
      layout->set_cross_axis_alignment(
          views::BoxLayout::CrossAxisAlignment::kCenter);
      entry->image = action->AddChildView(std::make_unique<views::ImageView>());
      entry->image->SetCanProcessEventsWithinSubtree(false);
    }
    result = std::move(action);
  } else if (node.type == "toggle") {
    auto row = std::make_unique<views::View>();
    auto* layout = row->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal, gfx::Insets(), 8));
    auto label = std::make_unique<views::Label>();
    label->SetAutoColorReadabilityEnabled(false);
    label->SetHorizontalAlignment(gfx::ALIGN_LEFT);
    entry->label = row->AddChildView(std::move(label));
    layout->SetFlexForView(entry->label, 1);
    entry->control = row->AddChildView(
        std::make_unique<views::ToggleButton>(std::move(callback)));
    result = std::move(row);
  } else if (IsTextControl(node.type)) {
    std::unique_ptr<views::Textfield> input;
    if (node.type == "textarea") {
      input = std::make_unique<PanelTextarea>(base::BindRepeating(
          [](base::WeakPtr<NativePanelHost> host, views::Textfield* sender,
             const ui::KeyEvent& event) {
            return host && host->HandleKeyEvent(sender, event);
          },
          weak_factory_.GetWeakPtr()));
    } else {
      input = std::make_unique<views::Textfield>();
    }
    input->SetController(this);
    input->SetDefaultWidthInChars(16);
    input->SetPlaceholderTextColorId(ui::kColorTextfieldForegroundPlaceholder);
    result = std::move(input);
  } else if (node.type == "option") {
    entry->model = std::make_unique<OptionModel>();
    auto option = std::make_unique<views::Combobox>(entry->model.get());
    option->SetCallback(std::move(callback));
    result = std::move(option);
  } else if (node.type == "list") {
    auto scroll = std::make_unique<views::ScrollView>();
    scroll->SetVerticalScrollBar(std::make_unique<PanelScrollBar>());
    scroll->SetDrawOverflowIndicator(false);
    scroll->SetBackgroundColor(std::nullopt);
    scroll->SetHorizontalScrollBarMode(
        views::ScrollView::ScrollBarMode::kDisabled);
    entry->scroll = scroll.get();
    auto contents = std::make_unique<views::View>();
    contents->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kVertical));
    entry->children = scroll->SetContents(std::move(contents));
    result = std::move(scroll);
  } else if (node.type == "separator") {
    auto separator = std::make_unique<views::Separator>();
    separator->SetOrientation(views::Separator::Orientation::kHorizontal);
    result = std::move(separator);
  } else if (node.type == "progress") {
    result = std::make_unique<views::ProgressBar>();
  } else {
    auto container = std::make_unique<PanelContainer>();
    container->SetLayoutManager(std::make_unique<views::BoxLayout>(
        node.type == "row" ? views::BoxLayout::Orientation::kHorizontal
                           : views::BoxLayout::Orientation::kVertical));
    entry->children = container.get();
    result = std::move(container);
  }
  entry->view = result.get();
  if (!entry->control)
    entry->control = result.get();
  return result;
}

void NativePanelHost::ApplyProperties(const NativePanelNode& node,
                                      Entry* entry) {
  const auto& properties = node.properties;
  const base::DictValue empty_style;
  const auto* style = properties.FindDict("style");
  if (!style)
    style = &empty_style;
  views::View* view = entry->view;
  view->SetEnabled(!properties.FindBool("disabled").value_or(false));
  view->SetVisible(properties.FindBool("visible").value_or(true));
  view->SetTooltipText(base::UTF8ToUTF16(String(properties, "tooltip")));
  std::u16string text = base::UTF8ToUTF16(String(properties, "text"));
  if (entry->label)
    entry->label->SetText(text);
  if (entry->linked_label)
    entry->linked_label->SetText(text);
  if (entry->children) {
    auto* layout =
        static_cast<views::BoxLayout*>(entry->children->GetLayoutManager());
    layout->set_between_child_spacing(Integer(properties, "gap", 6));
    layout->set_inside_border_insets(
        ControlInsets(*style, Integer(properties, "padding", 0)));
    layout->set_cross_axis_alignment(
        String(*style, "align") == "start"
            ? views::BoxLayout::CrossAxisAlignment::kStart
        : String(*style, "align") == "center"
            ? views::BoxLayout::CrossAxisAlignment::kCenter
        : String(*style, "align") == "end"
            ? views::BoxLayout::CrossAxisAlignment::kEnd
            : views::BoxLayout::CrossAxisAlignment::kStretch);
    entry->children->InvalidateLayout();
  }
  if (node.type == "button") {
    auto* button = static_cast<PanelButton*>(view);
    button->SetText(text);
    button->SetPlain(String(properties, "variant") == "plain", *style);
    button->SetImageModel(views::Button::STATE_NORMAL,
                          ui::ImageModel::FromImageSkia(node.image));
    const bool padded =
        String(properties, "variant") == "plain" ||
        style->contains("paddingTop") || style->contains("paddingRight") ||
        style->contains("paddingBottom") || style->contains("paddingLeft");
    button->SetCustomPadding(
        padded ? std::make_optional(ControlInsets(*style, 6)) : std::nullopt);
    if (style->contains("radius"))
      button->SetCornerRadius(Integer(*style, "radius", 8));
  } else if (node.type == "text") {
    if (entry->label) {
      entry->label->SetMultiLine(
          !properties.FindBool("singleLine").value_or(false));
      entry->label->SetElideBehavior(gfx::ELIDE_TAIL);
      entry->label->SetAllowCharacterBreak(true);
    }
  } else if (node.type == "icon" || node.type == "iconButton") {
    auto* icon = node.type == "iconButton"
                     ? entry->image.get()
                     : static_cast<views::ImageView*>(view);
    icon->SetImage(ui::ImageModel::FromImageSkia(node.image));
    icon->SetImageSize(node.type == "iconButton"
                           ? gfx::Size(20, 20)
                           : gfx::Size(Integer(properties, "width", 20),
                                       Integer(properties, "height", 20)));
    if (node.type == "iconButton")
      view->SetPreferredSize(gfx::Size(32, 32));
  } else if (node.type == "toggle") {
    auto* control = static_cast<views::ToggleButton*>(entry->control.get());
    const base::Value* checked = properties.Find("checked");
    const base::Value* old_checked = entry->properties.Find("checked");
    if (checked && (!old_checked || *old_checked != *checked))
      control->SetIsOn(checked->GetBool());
    control->GetViewAccessibility().SetName(text);
  } else if (IsTextControl(node.type)) {
    auto* input = static_cast<views::Textfield*>(view);
    const std::string* value = properties.FindString("value");
    const std::string* old_value = entry->properties.FindString("value");
    if (value && (!old_value || *value != *old_value)) {
      if (input->IsIMEComposing()) {
        entry->pending_input = base::UTF8ToUTF16(*value);
      } else {
        input->SetText(base::UTF8ToUTF16(*value));
        entry->pending_input.reset();
      }
    } else if (!value) {
      entry->pending_input.reset();
    }
    input->SetPlaceholderText(
        base::UTF8ToUTF16(String(properties, "placeholder")));
    if (node.type == "textarea") {
      static_cast<PanelTextarea*>(input)->SetAppearance(*style);
      static_cast<PanelTextarea*>(input)->SetScrollbarPlacement(
          String(properties, "scrollbarPlacement", "gutter"));
    } else if (style->FindBool("borderless").value_or(false)) {
      input->SetBorder(views::CreateEmptyBorder(ControlInsets(*style, 2)));
      // Keep a transparent native painter so Textfield disables LCD rendering
      // for both text and placeholder on this translucent panel window.
      input->SetBackgroundEnabled(true);
      input->SetBackgroundColor(SK_ColorTRANSPARENT);
    } else if (const auto* old = entry->properties.FindDict("style");
               old && old->FindBool("borderless").value_or(false)) {
      input->SetBorder(views::CreateRoundedRectBorder(
          1, 4, ui::kColorFocusableBorderUnfocused));
      input->SetBackgroundColor(std::nullopt);
      input->SetBackgroundEnabled(true);
    }
    input->GetViewAccessibility().SetName(base::UTF8ToUTF16(String(
        properties, "tooltip", String(properties, "placeholder", node.id))));
  } else if (node.type == "option") {
    auto* option = static_cast<views::Combobox*>(view);
    std::string selected;
    if (auto index = option->GetSelectedIndex())
      selected = entry->model->ValueAt(*index);
    const auto* items = properties.FindList("items");
    const auto* old_items = entry->properties.FindList("items");
    if (items && (!old_items || *items != *old_items))
      entry->model->Update(*items);
    const auto* value = properties.FindString("value");
    const auto* old_value = entry->properties.FindString("value");
    if (value && (!old_value || *value != *old_value))
      selected = *value;
    auto index = entry->model->IndexOf(selected);
    option->SetSelectedIndex(index ? index : entry->model->GetDefaultIndex());
    option->SetTooltipTextAndAccessibleName(
        base::UTF8ToUTF16(String(properties, "tooltip", node.id)));
  } else if (node.type == "progress") {
    double value = properties.FindDouble("value").value_or(0);
    static_cast<views::ProgressBar*>(view)->SetValue(
        !visible_ && value < 0 ? 0 : value);
  } else if (node.type == "list") {
    const int height = Integer(properties, "height", 240);
    entry->scroll->ClipHeightTo(height, height);
    static_cast<PanelScrollBar*>(entry->scroll->vertical_scroll_bar())
        ->SetPlacement(String(properties, "scrollbarPlacement", "gutter"));
  }
  if (node.type == "item" || node.type == "iconButton") {
    view->GetViewAccessibility().SetName(base::UTF8ToUTF16(String(
        properties, "accessibleName", String(properties, "tooltip", node.id))));
    view->GetViewAccessibility().SetIsSelected(
        properties.FindBool("selected").value_or(false));
    if (properties.FindBool("selected").value_or(false) &&
        !entry->properties.FindBool("selected").value_or(false))
      reveal_selection_ = node.id;
  }
  entry->properties = properties.Clone();
}

NativePanelHost::Entry& NativePanelHost::Reconcile(const NativePanelNode& node,
                                                   views::View* parent,
                                                   size_t index) {
  auto found = entries_.find(node.id);
  if (found != entries_.end() &&
      (found->second->type != node.type ||
       (node.type == "text" && static_cast<bool>(found->second->linked_label) !=
                                   node.properties.contains("linkRange")))) {
    RemoveSubtree(found->second->view);
    found = entries_.end();
  }
  if (found == entries_.end()) {
    auto entry = std::make_unique<Entry>();
    entry->id = node.id;
    entry->type = node.type;
    auto control = CreateControl(node, entry.get());
    parent->AddChildViewAt(std::move(control), index);
    found = entries_.emplace(node.id, std::move(entry)).first;
  } else {
    views::View* view = found->second->view;
    auto detached = detached_.find(node.id);
    if (detached != detached_.end()) {
      parent->AddChildViewAt(std::move(detached->second), index);
      detached_.erase(detached);
    } else if (view->parent() != parent) {
      parent->AddChildViewAt(view->parent()->RemoveChildViewT(view), index);
    } else {
      parent->ReorderChildView(view, index);
    }
  }
  Entry& entry = *found->second;
  // Remove stale explicit dimensions before measuring the new content.
  entry.view->SetPreferredSize(std::nullopt);
  ApplyProperties(node, &entry);
  if (entry.children) {
    for (size_t child_index = 0; child_index < node.children.size();
         ++child_index) {
      Entry& child =
          Reconcile(node.children[child_index], entry.children, child_index);
      child.parent_id = node.id;
      static_cast<views::BoxLayout*>(entry.children->GetLayoutManager())
          ->SetFlexForView(
              child.view,
              Integer(node.children[child_index].properties, "flex", 0));
    }
  }
  int width = Integer(node.properties, "width", 0);
  int height = Integer(node.properties, "height", 0);
  int max_width = Integer(node.properties, "maxWidth", 0);
  if (node.type == "row" || node.type == "column") {
    static_cast<PanelContainer*>(entry.view.get())
        ->SetDimensions(width, height, max_width);
  } else if (node.type == "text") {
    if (entry.linked_label)
      static_cast<PanelLinkedLabel*>(entry.view.get())
          ->SetDimensions(width, height, max_width);
    else
      static_cast<PanelLabel*>(entry.view.get())
          ->SetDimensions(width, height, max_width);
  } else if (width > 0 || height > 0 || max_width > 0) {
    gfx::Size size = entry.view->GetPreferredSize({});
    if (width > 0)
      size.set_width(width);
    if (height > 0)
      size.set_height(height);
    if (max_width > 0)
      size.set_width(std::min(size.width(), max_width));
    entry.view->SetPreferredSize(size);
  }
  return entry;
}

void NativePanelHost::RemoveSubtree(views::View* root) {
  std::vector<std::string> removed;
  for (const auto& [id, entry] : entries_) {
    if (root == entry->view || root->Contains(entry->view))
      removed.push_back(id);
  }
  std::unique_ptr<views::View> removed_view;
  if (root->parent())
    removed_view = root->parent()->RemoveChildViewT(root);
  // Comboboxes retain their model pointer until their destructor finishes.
  removed_view.reset();
  for (const auto& id : removed)
    entries_.erase(id);
}

void NativePanelHost::UpdateContent(NativePanelNode content) {
  auto textarea_viewports = PreserveTextareaViewports();
  base::AutoReset<bool> applying(&applying_, true);
  const int outer_scroll_position = ScrollPosition(outer_scroll_);
  struct Desired {
    std::string type;
    std::string parent;
  };
  std::map<std::string, Desired> desired;
  auto collect = [&](auto&& self, const NativePanelNode& node,
                     const std::string& parent) -> void {
    desired[node.id] = {node.type, parent};
    for (const auto& child : node.children)
      self(self, child, node.id);
  };
  collect(collect, content, {});
  // Unchanged nodes remain attached throughout ordinary updates. Only controls
  // actually moved to a different container are temporarily detached.
  std::string focused;
  if (auto* manager = widget_->GetFocusManager()) {
    for (const auto& [id, entry] : entries_) {
      if (entry->control == manager->GetFocusedView() ||
          (entry->linked_label && manager->GetFocusedView() &&
           entry->linked_label->Contains(manager->GetFocusedView())))
        focused = id;
    }
  }
  std::map<std::string, int> scroll_positions;
  for (auto& [id, entry] : entries_) {
    if (entry->scroll)
      scroll_positions[id] = ScrollPosition(entry->scroll);
    auto next = desired.find(id);
    bool parent_replaced = false;
    if (!entry->parent_id.empty()) {
      auto old_parent = entries_.find(entry->parent_id);
      auto new_parent = desired.find(entry->parent_id);
      parent_replaced = new_parent == desired.end() ||
                        (old_parent != entries_.end() &&
                         new_parent->second.type != old_parent->second->type);
    }
    if (next != desired.end() && next->second.type == entry->type &&
        (next->second.parent != entry->parent_id || parent_replaced) &&
        entry->view->parent()) {
      detached_[id] =
          entry->view->parent()->RemoveChildViewT(entry->view.get());
    }
  }
  while (true) {
    auto obsolete =
        std::find_if(entries_.begin(), entries_.end(), [&](const auto& pair) {
          auto next = desired.find(pair.first);
          return next == desired.end() ||
                 next->second.type != pair.second->type;
        });
    if (obsolete == entries_.end())
      break;
    RemoveSubtree(obsolete->second->view);
  }
  Reconcile(content, content_container_, 0).parent_id.clear();
  options_.content = std::move(content);
  ApplyTheme();
  LayoutAtAnchor();
  outer_scroll_->ScrollToPosition(outer_scroll_->vertical_scroll_bar(),
                                  outer_scroll_position);
  for (const auto& [id, position] : scroll_positions) {
    auto entry = entries_.find(id);
    if (entry != entries_.end() && entry->second->scroll) {
      auto* scroll = entry->second->scroll.get();
      scroll->ScrollToPosition(scroll->vertical_scroll_bar(), position);
    }
  }
  if (!focused.empty()) {
    auto entry = entries_.find(focused);
    if (entry != entries_.end() && visible_ &&
        widget_->GetFocusManager()->GetFocusedView() !=
            entry->second->control) {
      entry->second->FocusTarget()->RequestFocus();
    }
  }
  if (!reveal_selection_.empty()) {
    auto selected = entries_.find(reveal_selection_);
    if (selected != entries_.end())
      selected->second->view->ScrollViewToVisible();
    reveal_selection_.clear();
  }
}

void NativePanelHost::UpdateBackgroundMaterial() {
  if (!native_windows_valid_ || !hwnd_ || !surface_ || applying_material_ ||
      destroying_)
    return;
  base::AutoReset<bool> applying(&applying_material_, true);
  bool enable = options_.background_material == "acrylic";
  material_fallback_reason_.clear();
  const auto* native_theme = ui::NativeTheme::GetInstanceForNativeUi();
  const bool supported =
      base::win::GetVersion() >= base::win::Version::WIN11_22H2;
  BOOL composition = FALSE;
  SYSTEM_POWER_STATUS power = {};
  if (enable) {
    if (!supported) {
      material_fallback_reason_ = "unsupported-windows-version";
    } else if (native_theme->forced_colors() !=
               ui::ColorProviderKey::ForcedColors::kNone) {
      material_fallback_reason_ = "forced-colors";
    } else if (native_theme->prefers_reduced_transparency()) {
      material_fallback_reason_ = "reduced-transparency";
    } else if (::GetSystemPowerStatus(&power) && power.SystemStatusFlag == 1) {
      material_fallback_reason_ = "battery-saver";
    } else if (FAILED(::DwmIsCompositionEnabled(&composition)) ||
               !composition) {
      material_fallback_reason_ = "composition-unavailable";
    }
    enable = material_fallback_reason_.empty();
  }

  // Leave an ordinary panel's native frame untouched. Reconfigure DWM only
  // for material transitions, theme/policy changes or composition recovery.
  const std::string mode = String(options_.theme, "mode", "system");
  const BOOL dark =
      mode == "dark" ||
      (mode == "system" && native_theme->preferred_color_scheme() ==
                               ui::NativeTheme::PreferredColorScheme::kDark);
  const std::string configuration =
      std::string(enable ? "acrylic:" : "none:") + (dark ? "dark" : "light");
  if (supported && configuration != material_system_configuration_ &&
      (options_.background_material == "acrylic" || acrylic_applied_ ||
       !material_system_configuration_.empty())) {
    ::DwmSetWindowAttribute(hwnd_, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark,
                            sizeof(dark));
    const MARGINS margins =
        enable ? MARGINS{-1, -1, -1, -1} : MARGINS{0, 0, 0, 0};
    const HRESULT frame_result =
        ::DwmExtendFrameIntoClientArea(hwnd_, &margins);
    const DWM_SYSTEMBACKDROP_TYPE backdrop =
        enable ? DWMSBT_TRANSIENTWINDOW : DWMSBT_NONE;
    const HRESULT backdrop_result = ::DwmSetWindowAttribute(
        hwnd_, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop, sizeof(backdrop));
    if (enable && (FAILED(frame_result) || FAILED(backdrop_result))) {
      enable = false;
      material_fallback_reason_ = "dwm-unavailable";
      const MARGINS reset = {};
      ::DwmExtendFrameIntoClientArea(hwnd_, &reset);
      const DWM_SYSTEMBACKDROP_TYPE none = DWMSBT_NONE;
      ::DwmSetWindowAttribute(hwnd_, DWMWA_SYSTEMBACKDROP_TYPE, &none,
                              sizeof(none));
    }
    // The panel supplies its own outline. DWM must not add a caption strip or
    // a second colored border to this frameless, separately shadowed popup.
    const COLORREF color = enable ? DWMWA_COLOR_NONE : DWMWA_COLOR_DEFAULT;
    ::DwmSetWindowAttribute(hwnd_, DWMWA_CAPTION_COLOR, &color, sizeof(color));
    ::DwmSetWindowAttribute(hwnd_, DWMWA_BORDER_COLOR, &color, sizeof(color));
    if (enable)
      ::DefWindowProc(hwnd_, WM_NCACTIVATE, TRUE, -1);
    material_system_configuration_ =
        std::string(enable ? "acrylic:" : "none:") + (dark ? "dark" : "light");
  }
  acrylic_applied_ = enable;
  surface_->SetAcrylicApplied(enable,
                              options_.background_material == "acrylic");
  UpdateInputRegion();
}

void NativePanelHost::ApplyTheme() {
  if (applying_theme_)
    return;
  auto textarea_viewports = PreserveTextareaViewports();
  base::AutoReset<bool> applying_theme(&applying_theme_, true);
  static_cast<PanelWidget*>(widget_.get())->SetPanelTheme(options_.theme);
  EnsureShadowWindow();
  if (shadow_widget_) {
    static_cast<PanelWidget*>(shadow_widget_.get())
        ->SetPanelTheme(options_.theme);
    shadow_surface_->SetAppearance(options_.theme, options_.radius, true,
                                   options_.content_inset);
  }
  surface_->SetAppearance(options_.theme, options_.radius, options_.shadow,
                          options_.content_inset);
  UpdateBackgroundMaterial();
  const auto* provider = surface_->GetColorProvider();
  SkColor text = Color(options_.theme, "text",
                       provider->GetColor(ui::kColorLabelForeground));
  SkColor muted = Color(options_.theme, "muted",
                        provider->GetColor(ui::kColorLabelForegroundSecondary));
  SkColor accent = Color(options_.theme, "accent",
                         provider->GetColor(ui::kColorFocusableBorderFocused));
  int font_size = Integer(options_.theme, "fontSize", 13);
  std::string family = String(options_.theme, "fontFamily", "Segoe UI");
  for (auto& [id, entry] : entries_) {
    const base::DictValue empty_style;
    const auto* style = entry->properties.FindDict("style");
    if (!style)
      style = &empty_style;
    const auto weight = String(*style, "fontWeight");
    gfx::FontList font(std::vector<std::string>{family}, gfx::Font::NORMAL,
                       Integer(entry->properties, "fontSize", font_size),
                       weight == "bold"     ? gfx::Font::Weight::BOLD
                       : weight == "medium" ? gfx::Font::Weight::MEDIUM
                                            : gfx::Font::Weight::NORMAL);
    if (entry->label) {
      entry->label->SetTextStyle(views::style::STYLE_PRIMARY);
      entry->label->SetFontList(font);
      entry->label->SetEnabledColor(Color(
          *style, "color",
          entry->properties.FindBool("muted").value_or(false) ? muted : text));
      const auto align = String(*style, "align", "start");
      const bool end = align == "end";
      entry->label->SetHorizontalAlignment(align == "center" ? gfx::ALIGN_CENTER
                                           : end != base::i18n::IsRTL()
                                               ? gfx::ALIGN_RIGHT
                                               : gfx::ALIGN_LEFT);
      if (const auto* ranges = entry->properties.FindList("highlights")) {
        for (const auto& range : *ranges) {
          if (range.is_dict())
            entry->label->SetTextStyleRange(
                views::style::STYLE_EMPHASIZED,
                gfx::Range(Integer(range.GetDict(), "start", 0),
                           Integer(range.GetDict(), "end", 0)));
        }
      }
    }
    if (entry->linked_label) {
      auto appearance = entry->properties.Clone();
      appearance.Set("theme", options_.theme.Clone());
      if (appearance != entry->linked_appearance) {
        entry->linked_appearance = std::move(appearance);
        auto* label = entry->linked_label.get();
        label->ClearStyleRanges();
        const auto* range = entry->properties.FindDict("linkRange");
        const int start = Integer(*range, "start", 0);
        const int end = Integer(*range, "end", 0);
        const int length = label->GetText().size();
        views::StyledLabel::RangeStyleInfo normal;
        normal.custom_font = font;
        normal.override_color = Color(
            *style, "color",
            entry->properties.FindBool("muted").value_or(false) ? muted : text);
        if (start > 0)
          label->AddStyleRange(gfx::Range(0, start), normal);
        auto link = views::StyledLabel::RangeStyleInfo::CreateForLink(
            base::BindRepeating(&NativePanelHost::SendAction,
                                weak_factory_.GetWeakPtr(), id, "click"));
        link.custom_font = font;
        label->AddStyleRange(gfx::Range(start, end), link);
        if (end < length)
          label->AddStyleRange(gfx::Range(end, length), normal);
      }
    }
    if (entry->type == "button") {
      auto* button = static_cast<views::MdTextButton*>(entry->view.get());
      button->SetEnabledTextColors(Color(*style, "color", text));
      static_cast<PanelButton*>(button)->SetPanelFont(font);
      const auto alignment = String(*style, "align", "center");
      button->SetHorizontalAlignment(alignment == "start" ? gfx::ALIGN_LEFT
                                     : alignment == "end" ? gfx::ALIGN_RIGHT
                                                          : gfx::ALIGN_CENTER);
    } else if (IsTextControl(entry->type)) {
      static_cast<views::Textfield*>(entry->view.get())->SetFontList(font);
      if (entry->type == "textarea")
        static_cast<PanelTextarea*>(entry->view.get())->SetAppearance(*style);
    } else if (entry->type == "toggle") {
      static_cast<views::ToggleButton*>(entry->control.get())
          ->SetTrackOnColor(accent);
    } else if (entry->type == "progress") {
      static_cast<views::ProgressBar*>(entry->view.get())
          ->SetForegroundColor(accent);
    }
    if (entry->type == "item" || entry->type == "iconButton") {
      static_cast<PanelAction*>(entry->view.get())
          ->SetAppearance(
              *style, entry->properties.FindBool("selected").value_or(false),
              SkColorSetARGB(18, 128, 128, 128));
    } else if (entry->type != "button" && !IsTextControl(entry->type)) {
      entry->view->SetBackground(views::CreateRoundedRectBackground(
          Color(*style, "background", SK_ColorTRANSPARENT),
          Integer(*style, "radius", 0)));
      const int stroke = Integer(*style, "borderWidth", 0);
      entry->view->SetBorder(stroke ? views::CreateRoundedRectBorder(
                                          stroke, Integer(*style, "radius", 0),
                                          Color(*style, "borderColor", text))
                                    : nullptr);
    }
  }
}

void NativePanelHost::UpdateAppearance(base::DictValue theme,
                                       int radius,
                                       bool shadow,
                                       int content_inset,
                                       const std::string& background_material,
                                       const std::string& scrollbar_placement) {
  auto textarea_viewports = PreserveTextareaViewports();
  std::string focused_link;
  auto* focused = widget_->GetFocusManager()->GetFocusedView();
  for (const auto& [id, entry] : entries_)
    if (focused && entry->linked_label &&
        entry->linked_label->Contains(focused))
      focused_link = id;
  options_.content_inset = content_inset;
  options_.theme = std::move(theme);
  options_.radius = radius;
  options_.shadow = shadow;
  options_.background_material = background_material;
  options_.scrollbar_placement = scrollbar_placement;
  static_cast<PanelScrollBar*>(outer_scroll_->vertical_scroll_bar())
      ->SetPlacement(scrollbar_placement);
  ApplyTheme();
  LayoutAtAnchor();
  if (!focused_link.empty()) {
    auto found = entries_.find(focused_link);
    if (found != entries_.end() && visible_)
      found->second->FocusTarget()->RequestFocus();
  }
}

void NativePanelHost::Show(const gfx::Rect& anchor,
                           const std::string& placement) {
  if (!native_windows_valid_ || !parent_ || !widget_ || parent_->IsClosed() ||
      !parent_->IsVisible() || parent_->IsMinimized())
    return;
  anchor_ = anchor;
  placement_ = placement;
  parent_bounds_ = parent_->GetWindowBoundsInScreen();
  LayoutAtAnchor();
  if (visible_)
    return;
  if (parent_->GetFocusManager())
    restore_focus_->SetView(parent_->GetFocusManager()->GetFocusedView());
  visible_ = true;
  for (const auto& [id, entry] : entries_) {
    if (entry->type == "progress")
      static_cast<views::ProgressBar*>(entry->view.get())
          ->SetValue(entry->properties.FindDouble("value").value_or(0));
  }
  if (options_.dismiss_on_outside_click)
    AddMouseMonitor(this);
  if (shadow_widget_)
    shadow_widget_->ShowInactive();
  if (options_.focus_mode == "none") {
    widget_->ShowInactive();
  } else {
    widget_->Show();
    widget_->Activate();
    if (options_.focus_mode == "input" &&
        !widget_->GetFocusManager()->GetFocusedView())
      widget_->GetFocusManager()->AdvanceFocus(false);
  }
  if (shadow_widget_) {
    ::SetWindowPos(
        views::HWNDForWidget(shadow_widget_.get()), hwnd_, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  }
  event_monitor_ = views::EventMonitor::CreateApplicationMonitor(
      this, parent_->GetNativeWindow(), {ui::EventType::kKeyPressed});
}

void NativePanelHost::UpdateAnchor(const gfx::Rect& anchor) {
  anchor_ = anchor;
  LayoutAtAnchor();
}

void NativePanelHost::LayoutAtAnchor() {
  auto textarea_viewports = PreserveTextareaViewports();
  if (!widget_ || !surface_ || !content_container_)
    return;
  gfx::Rect work =
      display::Screen::Get()->GetDisplayMatching(anchor_).work_area();
  // Windows rounds both edges when converting DIP bounds to and from physical
  // pixels. Keep the complete native rect inside the work area at fractional
  // DPI, including its shadow and the possible enclosing-pixel expansion.
  work.Inset(2);
  const int shadow = options_.shadow ? kShadowInset : 0;
  int body_width = Integer(options_.content.properties, "width", 320);
  body_width =
      std::clamp(body_width, 1, std::max(1, work.width() - 2 * shadow));
  int max_body_height = std::max(1, work.height() - 2 * shadow);
  const int inner_width = std::max(1, body_width - 2 * options_.content_inset);
  int preferred_height = content_container_->GetHeightForWidth(inner_width) +
                         2 * options_.content_inset;
  int body_height = std::clamp(preferred_height, 1, max_body_height);
  bool top = placement_ == "top-start" || placement_ == "top-end";
  const int below = std::max(0, work.bottom() - anchor_.bottom() - 4 - shadow);
  const int above = std::max(0, anchor_.y() - work.y() - 4 - shadow);
  if (top ? (above < body_height && below > above)
          : (below < body_height && above > below))
    top = !top;
  const int available = top ? above : below;
  // Prefer a scrollable panel on the chosen side. If the anchor is outside the
  // work area, clamp the complete panel to the closest monitor instead.
  if (available >= 48)
    body_height = std::min(body_height, available);
  bool end = placement_ == "bottom-end" || placement_ == "top-end";
  int x = end ? anchor_.right() - body_width : anchor_.x();
  int y = top ? anchor_.y() - body_height - 4 : anchor_.bottom() + 4;
  x = std::clamp(
      x, work.x() + shadow,
      std::max(work.x() + shadow, work.right() - body_width - shadow));
  y = std::clamp(
      y, work.y() + shadow,
      std::max(work.y() + shadow, work.bottom() - body_height - shadow));
  outer_scroll_->ClipHeightTo(
      0, std::max(1, body_height - 2 * options_.content_inset));
  widget_->SetBounds(gfx::Rect(x - shadow, y - shadow, body_width + 2 * shadow,
                               body_height + 2 * shadow));
  widget_->GetRootView()->InvalidateLayout();
  widget_->LayoutRootViewIfNecessary();
  // Clip only the inner content layer. The surface keeps drawing its shadow
  // outside this mask, while large custom corner radii cannot let controls
  // paint into pixels which WM_NCHITTEST correctly excludes.
  float body_radius = std::min({static_cast<float>(options_.radius),
                                body_width / 2.f, body_height / 2.f});
  outer_scroll_->layer()->SetRoundedCornerRadius(gfx::RoundedCornersF(
      std::max(0.f, body_radius - options_.content_inset)));
  UpdateInputRegion();
  if (shadow_widget_) {
    shadow_widget_->SetBounds(widget_->GetWindowBoundsInScreen());
    shadow_widget_->GetRootView()->InvalidateLayout();
    shadow_widget_->LayoutRootViewIfNecessary();
    if (visible_) {
      shadow_widget_->ShowInactive();
      ::SetWindowPos(
          views::HWNDForWidget(shadow_widget_.get()), hwnd_, 0, 0, 0, 0,
          SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
  }
}

void NativePanelHost::Hide(bool restore_focus) {
  if (!visible_)
    return;
  HWND foreground = ::GetForegroundWindow();
  const bool owned_foreground =
      foreground == hwnd_ ||
      (parent_ && foreground == views::HWNDForWidget(parent_));
  visible_ = false;
  for (const auto& [id, entry] : entries_) {
    if (entry->type == "progress" &&
        entry->properties.FindDouble("value").value_or(0) < 0)
      static_cast<views::ProgressBar*>(entry->view.get())->SetValue(0);
  }
  RemoveMouseMonitor(this);
  event_monitor_.reset();
  if (shadow_widget_)
    shadow_widget_->Hide();
  if (widget_)
    widget_->Hide();
  if (restore_focus && owned_foreground)
    RestoreFocus();
}

void NativePanelHost::RestoreFocus() {
  if (!parent_ || !parent_->IsVisible() || parent_->IsClosed() ||
      parent_->IsMinimized())
    return;
  parent_->Activate();
  if (restore_focus_->view())
    restore_focus_->view()->RequestFocus();
}

void NativePanelHost::Dismiss(const std::string& reason) {
  if (!visible_)
    return;
  Hide(reason == "escape");
  // The callback may destroy this host. Keep it last.
  dismissed_.Run(reason);
}

void NativePanelHost::Destroy() {
  if (destroying_)
    return;
  destroying_ = true;
  weak_factory_.InvalidateWeakPtrs();
  Hide(false);
  RemoveMouseMonitor(this);
  event_monitor_.reset();
  if (parent_) {
    parent_->RemoveObserver(this);
    parent_ = nullptr;
  }
  if (surface_)
    surface_->RemovePreTargetHandler(this);
  RemoveWindowHook();
  if (widget_)
    widget_->RemoveObserver(this);
  widget_.reset();
  delegate_.reset();
  shadow_widget_.reset();
  shadow_delegate_.reset();
  shadow_surface_ = nullptr;
  surface_ = nullptr;
  outer_scroll_ = nullptr;
  content_container_ = nullptr;
  // Models must outlive the controls that observe them.
  detached_.clear();
  entries_.clear();
}

bool NativePanelHost::IsComposing() const {
  if (options_.focus_mode == "none" && parent_) {
    auto* method = parent_->GetInputMethod();
    if (method && method->GetTextInputClient() &&
        method->GetTextInputClient()->HasCompositionText())
      return true;
  }
  for (const auto& [id, entry] : entries_) {
    if (IsTextControl(entry->type) &&
        static_cast<views::Textfield*>(entry->view.get())->IsIMEComposing())
      return true;
  }
  return false;
}

bool NativePanelHost::IsRelatedWindow(HWND target) const {
  for (HWND current = target; current;
       current = ::GetWindow(current, GW_OWNER)) {
    if (current == hwnd_ || ::IsChild(hwnd_, current))
      return true;
  }
  return IsComposing() && IsImeWindow(target);
}

void NativePanelHost::OnGlobalMouseDown(gfx::Point point, HWND target) {
  if (!visible_ || !options_.dismiss_on_outside_click)
    return;
  if ((IsRelatedWindow(target) && target != hwnd_) || HitTestScreenPoint(point))
    return;
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&NativePanelHost::Dismiss,
                                weak_factory_.GetWeakPtr(), "outside-click"));
}

void NativePanelHost::OnWidgetBoundsChanged(views::Widget* widget,
                                            const gfx::Rect& bounds) {
  if (widget == widget_.get()) {
    UpdateInputRegion();
    return;
  }
  if (widget != parent_)
    return;
  anchor_.Offset(bounds.x() - parent_bounds_.x(),
                 bounds.y() - parent_bounds_.y());
  parent_bounds_ = bounds;
  if (visible_)
    LayoutAtAnchor();
}

void NativePanelHost::OnWidgetVisibilityChanged(views::Widget* widget,
                                                bool visible) {
  if (widget == parent_ && !visible && visible_)
    Dismiss("parent-hidden");
}

void NativePanelHost::OnWidgetShowStateChanged(views::Widget* widget) {
  if (widget == parent_ && parent_->IsMinimized() && visible_)
    Dismiss("parent-hidden");
}

void NativePanelHost::OnWidgetThemeChanged(views::Widget* widget) {
  if (widget == widget_.get() && !destroying_ && !applying_theme_)
    ApplyTheme();
}

void NativePanelHost::OnWidgetActivationChanged(views::Widget* widget,
                                                bool active) {
  if (widget != widget_.get() || active || !visible_ ||
      !options_.dismiss_on_outside_click)
    return;
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<NativePanelHost> self) {
                       if (self && self->visible_ &&
                           !self->IsRelatedWindow(::GetForegroundWindow()))
                         self->Dismiss("blur");
                     },
                     weak_factory_.GetWeakPtr()));
}

void NativePanelHost::OnWidgetDestroying(views::Widget* widget) {
  if (destroying_)
    return;
  if (widget == parent_) {
    parent_->RemoveObserver(this);
    parent_ = nullptr;
  }
  Hide(false);
  // Do not run JS while a parent Widget is midway through native teardown.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                              closed_);
}

void NativePanelHost::SendAction(const std::string& id,
                                 const std::string& type) {
  if (applying_ || !visible_)
    return;
  auto found = entries_.find(id);
  if (found == entries_.end())
    return;
  Entry& entry = *found->second;
  base::DictValue detail;
  detail.Set("id", id);
  detail.Set("type", type);
  if (IsTextControl(entry.type)) {
    detail.Set(
        "value",
        base::UTF16ToUTF8(
            static_cast<views::Textfield*>(entry.view.get())->GetText()));
  } else if (entry.type == "toggle") {
    detail.Set(
        "value",
        static_cast<views::ToggleButton*>(entry.control.get())->GetIsOn());
  } else if (entry.type == "option") {
    auto index =
        static_cast<views::Combobox*>(entry.view.get())->GetSelectedIndex();
    if (index)
      detail.Set("value", entry.model->ValueAt(*index));
  }
  action_.Run(std::move(detail));
}

void NativePanelHost::ContentsChanged(views::Textfield* sender,
                                      const std::u16string& contents) {
  for (const auto& [id, entry] : entries_) {
    if (entry->view != sender)
      continue;
    if (entry->pending_input && !sender->IsIMEComposing()) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&NativePanelHost::ApplyDeferredInput,
                                    weak_factory_.GetWeakPtr(), id));
    }
    int limit = Integer(entry->properties, "maxLength", 0);
    if (limit > 0 && contents.size() > static_cast<size_t>(limit) &&
        !sender->IsIMEComposing()) {
      sender->SetText(contents.substr(0, limit));
      sender->SetSelectedRange(gfx::Range(limit));
    }
    SendAction(id, "change");
    return;
  }
}

void NativePanelHost::ApplyDeferredInput(const std::string& id) {
  auto found = entries_.find(id);
  if (found == entries_.end() || !IsTextControl(found->second->type))
    return;
  Entry& entry = *found->second;
  auto* input = static_cast<views::Textfield*>(entry.view.get());
  if (input->IsIMEComposing())
    return;
  if (entry.pending_input) {
    input->SetText(*entry.pending_input);
    entry.pending_input.reset();
  }
  int limit = Integer(entry.properties, "maxLength", 0);
  if (limit > 0 && input->GetText().size() > static_cast<size_t>(limit)) {
    input->SetText(input->GetText().substr(0, limit));
    input->SetSelectedRange(gfx::Range(limit));
  }
}

void NativePanelHost::OnAfterUserAction(views::Textfield* sender) {
  for (const auto& [id, entry] : entries_) {
    if (entry->view == sender) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&NativePanelHost::ApplyDeferredInput,
                                    weak_factory_.GetWeakPtr(), id));
      return;
    }
  }
}

base::ScopedClosureRunner NativePanelHost::PreserveTextareaViewports() {
  std::vector<base::ScopedClosureRunner> viewports;
  for (const auto& [id, entry] : entries_) {
    if (entry->type == "textarea") {
      viewports.push_back(
          static_cast<PanelTextarea*>(entry->view.get())->PreserveViewport());
    }
  }
  return base::ScopedClosureRunner(base::BindOnce(
      [](std::vector<base::ScopedClosureRunner>) {}, std::move(viewports)));
}

bool NativePanelHost::HandleKeyEvent(views::Textfield* sender,
                                     const ui::KeyEvent& event) {
  if (!sender->IsIMEComposing()) {
    for (const auto& [id, entry] : entries_) {
      if (entry->view == sender) {
        ApplyDeferredInput(id);
        break;
      }
    }
  }
  if (event.type() != ui::EventType::kKeyPressed || sender->IsIMEComposing() ||
      event.key_code() != ui::VKEY_RETURN)
    return false;
  for (const auto& [id, entry] : entries_) {
    if (entry->view == sender) {
      if (entry->type == "textarea" &&
          (!entry->properties.FindBool("submitOnEnter").value_or(true) ||
           event.IsShiftDown() || event.IsControlDown() || event.IsAltDown() ||
           event.IsCommandDown() || event.IsAltGrDown()))
        return false;
      SendAction(id, "submit");
      return true;
    }
  }
  return false;
}

void NativePanelHost::OnKeyEvent(ui::KeyEvent* event) {
  if (visible_ && !IsComposing() &&
      event->type() == ui::EventType::kKeyPressed &&
      (event->key_code() == ui::VKEY_UP ||
       event->key_code() == ui::VKEY_DOWN)) {
    auto* focused = widget_->GetFocusManager()->GetFocusedView();
    for (const auto& [id, entry] : entries_)
      if (entry->view == focused &&
          (IsTextControl(entry->type) || entry->type == "option"))
        return;
    std::vector<Entry*> rows;
    auto collect = [&](auto&& self, const NativePanelNode& node) -> void {
      auto found = entries_.find(node.id);
      if (found != entries_.end() && node.type == "item" &&
          found->second->view->GetVisible() &&
          found->second->view->GetEnabled())
        rows.push_back(found->second.get());
      for (const auto& child : node.children)
        self(self, child);
    };
    collect(collect, options_.content);
    auto current = std::find_if(rows.begin(), rows.end(), [&](Entry* row) {
      return row->view == focused || (focused && row->view->Contains(focused));
    });
    if (current != rows.end() || (!focused && !rows.empty())) {
      int index = current == rows.end()
                      ? (event->key_code() == ui::VKEY_DOWN
                             ? -1
                             : static_cast<int>(rows.size()))
                      : static_cast<int>(current - rows.begin());
      index = std::clamp(index + (event->key_code() == ui::VKEY_DOWN ? 1 : -1),
                         0, static_cast<int>(rows.size()) - 1);
      rows[index]->view->RequestFocus();
      rows[index]->view->ScrollViewToVisible();
      event->SetHandled();
      return;
    }
  }
  if (visible_ && options_.dismiss_on_escape &&
      event->type() == ui::EventType::kKeyPressed &&
      event->key_code() == ui::VKEY_ESCAPE && !IsComposing()) {
    event->SetHandled();
    Dismiss("escape");
  }
}

void NativePanelHost::OnEvent(const ui::Event& event) {
  if (options_.focus_mode == "none" && visible_ && options_.dismiss_on_escape &&
      event.type() == ui::EventType::kKeyPressed &&
      event.AsKeyEvent()->key_code() == ui::VKEY_ESCAPE && !IsComposing())
    Dismiss("escape");
}

base::DictValue NativePanelHost::GetState() const {
  base::DictValue result;
  result.Set("destroyed", destroying_);
  result.Set("visible", visible_);
  result.Set("backgroundMaterial", options_.background_material);
  result.Set("backgroundMaterialApplied",
             acrylic_applied_ ? "acrylic" : "none");
  result.Set("materialFallbackReason", material_fallback_reason_);
  if (hwnd_) {
    DWM_SYSTEMBACKDROP_TYPE backdrop = DWMSBT_AUTO;
    if (SUCCEEDED(::DwmGetWindowAttribute(hwnd_, DWMWA_SYSTEMBACKDROP_TYPE,
                                          &backdrop, sizeof(backdrop))))
      result.Set("materialDwmBackdrop", static_cast<int>(backdrop));
  }
  if (outer_scroll_) {
    result.Set("scrollbar", static_cast<PanelScrollBar*>(
                                outer_scroll_->vertical_scroll_bar())
                                ->GetState());
    result.Set("contentHeight", outer_scroll_->contents()->height());
    result.Set("viewportHeight", outer_scroll_->height());
  }
  result.Set("anchorBounds", RectValue(anchor_));
  result.Set("theme", options_.theme.Clone());
  result.Set("scrollbarPlacement", options_.scrollbar_placement);
  result.Set("windowHandle",
             std::to_string(reinterpret_cast<uintptr_t>(hwnd_)));
  result.Set("nativeWindowsValid", native_windows_valid_);
  result.Set("parentWindowHandle",
             std::to_string(reinterpret_cast<uintptr_t>(
                 parent_ ? views::HWNDForWidget(parent_) : nullptr)));
  result.Set("shadowVisible", shadow_widget_ && visible_);
  if (shadow_widget_) {
    result.Set("shadowWindowHandle",
               std::to_string(reinterpret_cast<uintptr_t>(
                   views::HWNDForWidget(shadow_widget_.get()))));
    result.Set("shadowBounds",
               RectValue(shadow_widget_->GetWindowBoundsInScreen()));
  }
  result.Set("bounds", RectValue(widget_ ? widget_->GetWindowBoundsInScreen()
                                         : gfx::Rect()));
  if (surface_) {
    gfx::Rect body = surface_->BodyBounds();
    body.Offset(widget_->GetWindowBoundsInScreen().OffsetFromOrigin());
    result.Set("contentBounds", RectValue(body));
  }
  base::ListValue controls;
  for (const auto& [id, entry] : entries_) {
    base::DictValue control;
    control.Set("id", id);
    control.Set("type", entry->type);
    control.Set("bounds", RectValue(entry->control->GetBoundsInScreen()));
    if (entry->type == "item" || entry->type == "iconButton") {
      const auto* ring = views::FocusRing::Get(entry->view);
      control.Set("focusRing",
                  base::DictValue()
                      .Set("visible", ring->GetVisible())
                      .Set("bounds", RectValue(ring->GetBoundsInScreen()))
                      .Set("haloInset", ring->GetHaloInset())
                      .Set("haloThickness", ring->GetHaloThickness()));
    }
    if (entry->label)
      control.Set("text", base::UTF16ToUTF8(entry->label->GetText()));
    if (entry->linked_label) {
      control.Set("text", base::UTF16ToUTF8(entry->linked_label->GetText()));
      base::ListValue links;
      for (views::View* child : entry->linked_label->children())
        if (views::IsViewClass<views::Link>(child))
          links.Append(RectValue(child->GetBoundsInScreen()));
      control.Set("linkBounds", std::move(links));
    }
    if (entry->label) {
      control.Set("fontWeight",
                  static_cast<int>(entry->label->font_list().GetFontWeight()));
      control.Set("fontSize", entry->label->font_list().GetFontSize());
    }
    if (entry->type == "item")
      control.Set("selected",
                  entry->properties.FindBool("selected").value_or(false));
    if (widget_->GetFocusManager()->GetFocusedView() == entry->control ||
        (entry->linked_label && widget_->GetFocusManager()->GetFocusedView() &&
         entry->linked_label->Contains(
             widget_->GetFocusManager()->GetFocusedView())))
      result.Set("focusedId", id);
    if (IsTextControl(entry->type)) {
      auto* input = static_cast<views::Textfield*>(entry->view.get());
      control.Set("value", base::UTF16ToUTF8(input->GetText()));
      control.Set("composing", input->IsIMEComposing());
      const gfx::Range selection = input->GetSelectedRange();
      control.Set("selection",
                  base::DictValue()
                      .Set("start", static_cast<int>(selection.start()))
                      .Set("end", static_cast<int>(selection.end())));
      control.Set("caretBounds", RectValue(input->GetCaretBounds()));
      if (entry->type == "textarea")
        static_cast<PanelTextarea*>(input)->AppendState(&control);
    } else if (entry->type == "toggle") {
      control.Set(
          "checked",
          static_cast<views::ToggleButton*>(entry->control.get())->GetIsOn());
    } else if (entry->type == "option") {
      auto selected =
          static_cast<views::Combobox*>(entry->view.get())->GetSelectedIndex();
      if (selected)
        control.Set("value", entry->model->ValueAt(*selected));
    } else if (entry->type == "progress") {
      control.Set(
          "value",
          static_cast<views::ProgressBar*>(entry->view.get())->GetValue());
    }
    if (entry->scroll) {
      control.Set("scrollOffset", ScrollPosition(entry->scroll));
      auto* scrollbar =
          static_cast<PanelScrollBar*>(entry->scroll->vertical_scroll_bar());
      control.Set("scrollbar", scrollbar->GetState());
      control.Set("scrollbarPlacement", scrollbar->placement());
    }
    controls.Append(std::move(control));
  }
  result.Set("controls", std::move(controls));
  return result;
}

}  // namespace electron
