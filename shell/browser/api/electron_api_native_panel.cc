// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/api/electron_api_native_panel.h"

#include <cmath>
#include <optional>
#include <set>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/utf_string_conversions.h"
#include "gin/arguments.h"
#include "gin/dictionary.h"
#include "shell/browser/api/electron_api_base_window.h"
#include "shell/browser/javascript_environment.h"
#include "shell/browser/native_window.h"
#include "shell/common/gin_converters/gfx_converter.h"
#include "shell/common/gin_converters/image_converter.h"
#include "shell/common/gin_converters/value_converter.h"
#include "shell/common/gin_helper/constructor.h"
#include "shell/common/gin_helper/dictionary.h"
#include "shell/common/gin_helper/function_template.h"
#include "shell/common/gin_helper/object_template_builder.h"
#include "shell/common/node_includes.h"

#if BUILDFLAG(IS_WIN)
#include "shell/browser/ui/views/native_panel.h"
#include "ui/views/widget/widget.h"
#endif

namespace electron::api {

namespace {

void ThrowError(gin::Arguments* args, const char* message) {
  args->isolate()->ThrowException(
      v8::Exception::Error(gin::StringToV8(args->isolate(), message)));
}

#if BUILDFLAG(IS_WIN)

bool HasValue(gin::Dictionary* dictionary,
              const char* key,
              v8::Local<v8::Value>* value) {
  return dictionary->Get(key, value) && !(*value)->IsUndefined();
}

bool ParseBackgroundMaterial(v8::Isolate* isolate,
                             v8::Local<v8::Value> value,
                             std::string* material) {
  return value->IsString() && gin::ConvertFromV8(isolate, value, material) &&
         (*material == "none" || *material == "acrylic");
}

bool ParseScrollbarPlacement(v8::Isolate* isolate,
                             v8::Local<v8::Value> value,
                             std::string* placement) {
  return value->IsString() && gin::ConvertFromV8(isolate, value, placement) &&
         (*placement == "overlay" || *placement == "gutter");
}

bool ParseTheme(v8::Isolate* isolate,
                v8::Local<v8::Value> value,
                base::DictValue* theme) {
  if (value->IsString()) {
    std::string mode;
    if (!gin::ConvertFromV8(isolate, value, &mode) ||
        (mode != "system" && mode != "light" && mode != "dark"))
      return false;
    theme->Set("mode", mode);
    return true;
  }
  if (!value->IsObject() || value->IsArray())
    return false;
  gin::Dictionary dictionary(isolate, value.As<v8::Object>());
  theme->Set("mode", "system");
  for (const char* key : {"mode", "background", "text", "muted", "accent",
                          "border", "fontFamily"}) {
    v8::Local<v8::Value> field;
    if (!HasValue(&dictionary, key, &field))
      continue;
    std::string text;
    if (!gin::ConvertFromV8(isolate, field, &text))
      return false;
    if (std::string_view(key) == "mode") {
      if (text != "system" && text != "light" && text != "dark")
        return false;
    } else if (std::string_view(key) != "fontFamily") {
      if ((text.size() != 7 && text.size() != 9) || text[0] != '#')
        return false;
      for (size_t index = 1; index < text.size(); ++index) {
        if (!((text[index] >= '0' && text[index] <= '9') ||
              (text[index] >= 'a' && text[index] <= 'f') ||
              (text[index] >= 'A' && text[index] <= 'F')))
          return false;
      }
    }
    theme->Set(key, text);
  }
  v8::Local<v8::Value> size;
  if (HasValue(&dictionary, "fontSize", &size)) {
    double number;
    if (!gin::ConvertFromV8(isolate, size, &number) || !std::isfinite(number) ||
        number < 1 || number > 256)
      return false;
    theme->Set("fontSize", static_cast<int>(number));
  }
  return true;
}

bool ParseNode(v8::Isolate* isolate,
               v8::Local<v8::Value> value,
               NativePanelNode* node,
               std::set<std::string>* ids,
               int depth = 0) {
  if (depth > 64 || ids->size() >= 10000 || !value->IsObject() ||
      value->IsArray())
    return false;
  gin::Dictionary dictionary(isolate, value.As<v8::Object>());
  if (!dictionary.Get("type", &node->type) ||
      !dictionary.Get("id", &node->id) || node->id.empty() ||
      !ids->insert(node->id).second)
    return false;
  static const base::NoDestructor<std::set<std::string>> types(
      std::set<std::string>{"row", "column", "text", "icon", "button", "toggle",
                            "input", "textarea", "option", "list", "separator",
                            "progress", "item", "iconButton"});
  if (!types->contains(node->type))
    return false;
  v8::Local<v8::Value> submit_on_enter;
  if (node->type != "textarea" &&
      HasValue(&dictionary, "submitOnEnter", &submit_on_enter))
    return false;
  v8::Local<v8::Value> scrollbar_placement_value;
  if (HasValue(&dictionary, "scrollbarPlacement", &scrollbar_placement_value)) {
    std::string placement;
    if ((node->type != "list" && node->type != "textarea") ||
        !ParseScrollbarPlacement(isolate, scrollbar_placement_value,
                                 &placement))
      return false;
    node->properties.Set("scrollbarPlacement", placement);
  }
  if (node->type == "textarea") {
    static const base::NoDestructor<std::set<std::string>> fields(
        std::set<std::string>{"type", "id", "disabled", "visible", "width",
                              "height", "maxWidth", "flex", "tooltip", "style",
                              "value", "placeholder", "maxLength",
                              "submitOnEnter", "scrollbarPlacement"});
    auto context = isolate->GetCurrentContext();
    v8::Local<v8::Array> names;
    if (!value.As<v8::Object>()->GetOwnPropertyNames(context).ToLocal(&names))
      return false;
    for (uint32_t i = 0; i < names->Length(); ++i) {
      v8::Local<v8::Value> name, field;
      std::string key;
      if (!names->Get(context, i).ToLocal(&name) ||
          !gin::ConvertFromV8(isolate, name, &key) || !fields->contains(key) ||
          !dictionary.Get(key, &field))
        return false;
      if (key == "type" || key == "id" || key == "value" ||
          key == "placeholder" || key == "tooltip" ||
          key == "scrollbarPlacement") {
        if (!field->IsString() ||
            field.As<v8::String>()->Length() > (key == "id" ? 256 : 65536))
          return false;
      } else if (key == "disabled" || key == "visible" ||
                 key == "submitOnEnter") {
        if (!field->IsBoolean())
          return false;
      } else if (key != "style") {
        double number;
        const int maximum =
            key == "maxLength" ? 65536 : (key == "flex" ? 1000 : 100000);
        if (!field->IsNumber() ||
            !gin::ConvertFromV8(isolate, field, &number) ||
            !std::isfinite(number) || number < 0 || number > maximum ||
            (key == "maxLength" && std::floor(number) != number))
          return false;
      }
    }
  }
  for (const char* key : {"text", "value", "placeholder", "tooltip",
                          "accessibleName", "variant"}) {
    if (std::string_view(key) == "value" && node->type == "progress")
      continue;
    v8::Local<v8::Value> field;
    if (!HasValue(&dictionary, key, &field))
      continue;
    std::string text;
    if (!gin::ConvertFromV8(isolate, field, &text))
      return false;
    node->properties.Set(key, text);
  }
  for (const char* key : {"disabled", "visible", "muted", "checked",
                          "singleLine", "selected", "submitOnEnter"}) {
    v8::Local<v8::Value> field;
    if (!HasValue(&dictionary, key, &field))
      continue;
    bool boolean;
    if (!gin::ConvertFromV8(isolate, field, &boolean))
      return false;
    node->properties.Set(key, boolean);
  }
  for (const char* key : {"width", "height", "maxWidth", "flex", "gap",
                          "padding", "fontSize", "maxLength"}) {
    v8::Local<v8::Value> field;
    if (!HasValue(&dictionary, key, &field))
      continue;
    double number;
    if (!gin::ConvertFromV8(isolate, field, &number) ||
        !std::isfinite(number) || number < 0 || number > 1000000)
      return false;
    node->properties.Set(key, static_cast<int>(number));
  }
  if (node->type == "progress") {
    double progress;
    if (!dictionary.Get("value", &progress) || !std::isfinite(progress) ||
        (progress != -1 && (progress < 0 || progress > 1)))
      return false;
    node->properties.Set("value", progress);
  }
  v8::Local<v8::Value> extra;
  if ((node->type == "icon" || node->type == "iconButton" ||
       HasValue(&dictionary, "image", &extra)) &&
      !dictionary.Get("image", &node->image))
    return false;
  for (const char* key : {"style", "highlights", "linkRange"}) {
    if (!HasValue(&dictionary, key, &extra))
      continue;
    base::Value parsed;
    if (!gin::ConvertFromV8(isolate, extra, &parsed) ||
        (std::string_view(key) != "highlights" ? !parsed.is_dict()
                                               : !parsed.is_list()))
      return false;
    node->properties.Set(key, std::move(parsed));
  }
  if (node->type == "toggle" && !node->properties.FindBool("checked"))
    return false;
  if (const auto* range = node->properties.FindDict("linkRange")) {
    const auto start = range->FindInt("start"), end = range->FindInt("end");
    const auto* text = node->properties.FindString("text");
    if (!start || !end || !text || *start < 0 || *end <= *start ||
        static_cast<size_t>(*end) > base::UTF8ToUTF16(*text).size())
      return false;
  }
  if (node->type == "option") {
    std::vector<v8::Local<v8::Value>> items;
    if (!dictionary.Get("items", &items))
      return false;
    base::ListValue output;
    std::set<std::string> item_ids;
    for (auto item_value_object : items) {
      if (!item_value_object->IsObject() || item_value_object->IsArray())
        return false;
      gin::Dictionary item(isolate, item_value_object.As<v8::Object>());
      std::string id, label, item_value;
      bool disabled = false;
      if (!item.Get("id", &id) || id.empty() || !item_ids.insert(id).second ||
          !item.Get("label", &label))
        return false;
      item_value = id;
      item.Get("value", &item_value);
      item.Get("disabled", &disabled);
      output.Append(base::DictValue()
                        .Set("id", id)
                        .Set("label", label)
                        .Set("value", item_value)
                        .Set("disabled", disabled));
    }
    node->properties.Set("items", std::move(output));
  }
  if (node->type == "row" || node->type == "column" || node->type == "list" ||
      node->type == "item") {
    std::vector<v8::Local<v8::Value>> children;
    if (!dictionary.Get("children", &children))
      return false;
    for (auto child : children) {
      NativePanelNode description;
      if (!ParseNode(isolate, child, &description, ids, depth + 1))
        return false;
      node->children.push_back(std::move(description));
    }
  }
  return true;
}

bool ParseRect(gin::Dictionary* dictionary, gfx::Rect* rect) {
  gin::Dictionary bounds(nullptr);
  if (!dictionary->Get("anchorBounds", &bounds))
    return false;
  double x, y, width, height;
  if (!bounds.Get("x", &x) || !bounds.Get("y", &y) ||
      !bounds.Get("width", &width) || !bounds.Get("height", &height) ||
      !std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) ||
      !std::isfinite(height) || width < 0 || height < 0 ||
      std::abs(x) > 1000000 || std::abs(y) > 1000000 || width > 1000000 ||
      height > 1000000)
    return false;
  *rect = gfx::Rect(std::round(x), std::round(y), std::ceil(width),
                    std::ceil(height));
  return true;
}

#endif  // BUILDFLAG(IS_WIN)

}  // namespace

NativePanel::NativePanel() = default;
NativePanel::~NativePanel() = default;

bool NativePanel::IsSupported() {
  return BUILDFLAG(IS_WIN);
}

gin_helper::WrappableBase* NativePanel::New(gin::Arguments* args) {
#if BUILDFLAG(IS_WIN)
  gin::Dictionary dictionary(nullptr);
  v8::Local<v8::Value> parent_value, content_value, theme_value;
  if (!args->GetNext(&dictionary) || !dictionary.Get("parent", &parent_value) ||
      !dictionary.Get("content", &content_value)) {
    args->ThrowTypeError("NativePanel requires parent and content");
    return nullptr;
  }
  BaseWindow* parent = BaseWindow::FromValue(args->isolate(), parent_value);
  if (!parent || !parent->window() || !parent->window()->widget() ||
      parent->window()->widget()->IsClosed()) {
    args->ThrowTypeError("NativePanel requires a live BaseWindow parent");
    return nullptr;
  }
  NativePanelOptions options;
  std::set<std::string> ids;
  if (!ParseNode(args->isolate(), content_value, &options.content, &ids)) {
    args->ThrowTypeError("Invalid NativePanel content");
    return nullptr;
  }
  options.theme.Set("mode", "system");
  if (HasValue(&dictionary, "theme", &theme_value) &&
      !ParseTheme(args->isolate(), theme_value, &options.theme)) {
    args->ThrowTypeError("Invalid NativePanel theme");
    return nullptr;
  }
  v8::Local<v8::Value> material_value;
  if (HasValue(&dictionary, "backgroundMaterial", &material_value) &&
      !ParseBackgroundMaterial(args->isolate(), material_value,
                               &options.background_material)) {
    args->ThrowTypeError("Invalid NativePanel backgroundMaterial");
    return nullptr;
  }
  v8::Local<v8::Value> scrollbar_placement_value;
  if (HasValue(&dictionary, "scrollbarPlacement", &scrollbar_placement_value) &&
      !ParseScrollbarPlacement(args->isolate(), scrollbar_placement_value,
                               &options.scrollbar_placement)) {
    args->ThrowTypeError("Invalid NativePanel scrollbarPlacement");
    return nullptr;
  }
  dictionary.Get("radius", &options.radius);
  dictionary.Get("contentInset", &options.content_inset);
  dictionary.Get("shadow", &options.shadow);
  dictionary.Get("focusMode", &options.focus_mode);
  dictionary.Get("dismissOnOutsideClick", &options.dismiss_on_outside_click);
  dictionary.Get("dismissOnEscape", &options.dismiss_on_escape);
  if (options.radius < 0 || options.radius > 1000 ||
      options.content_inset < 0 || options.content_inset > 64 ||
      (options.focus_mode != "none" && options.focus_mode != "menu" &&
       options.focus_mode != "input")) {
    args->ThrowTypeError("Invalid NativePanel appearance or focusMode");
    return nullptr;
  }
  auto* panel = new NativePanel();
  panel->InitWithArgs(args);
  panel->theme_ = options.theme.Clone();
  panel->background_material_ = options.background_material;
  panel->scrollbar_placement_ = options.scrollbar_placement;
  panel->radius_ = options.radius;
  panel->content_inset_ = options.content_inset;
  panel->shadow_ = options.shadow;
  panel->host_ = std::make_unique<NativePanelHost>(
      parent->window()->widget(), std::move(options),
      base::BindRepeating(&NativePanel::OnAction,
                          panel->weak_factory_.GetWeakPtr()),
      base::BindRepeating(&NativePanel::OnDismissed,
                          panel->weak_factory_.GetWeakPtr()),
      base::BindRepeating(&NativePanel::OnClosed,
                          panel->weak_factory_.GetWeakPtr()));
  if (!panel->host_->IsValid()) {
    panel->destroyed_ = true;
    panel->host_.reset();
    ThrowError(args,
               "NativePanel could not create independent owned native windows");
    return nullptr;
  }
  return panel;
#else
  ThrowError(args, "NativePanel is not supported on this platform");
  return nullptr;
#endif
}

void NativePanel::Show(gin::Arguments* args) {
  if (destroyed_) {
    ThrowError(args, "NativePanel has been destroyed");
    return;
  }
#if BUILDFLAG(IS_WIN)
  gin::Dictionary dictionary(nullptr);
  gfx::Rect anchor;
  std::string placement = "auto";
  if (!args->GetNext(&dictionary) || !ParseRect(&dictionary, &anchor)) {
    args->ThrowTypeError("Invalid NativePanel anchorBounds");
    return;
  }
  dictionary.Get("placement", &placement);
  if (placement != "auto" && placement != "bottom-start" &&
      placement != "bottom-end" && placement != "top-start" &&
      placement != "top-end") {
    args->ThrowTypeError("Invalid NativePanel placement");
    return;
  }
  host_->Show(anchor, placement);
#endif
}

void NativePanel::Update(gin::Arguments* args) {
  if (destroyed_) {
    ThrowError(args, "NativePanel has been destroyed");
    return;
  }
#if BUILDFLAG(IS_WIN)
  gin::Dictionary dictionary(nullptr);
  if (!args->GetNext(&dictionary)) {
    args->ThrowTypeError("Invalid NativePanel update");
    return;
  }
  std::optional<NativePanelNode> content;
  std::optional<gfx::Rect> anchor;
  base::DictValue theme = theme_.Clone();
  std::string background_material = background_material_;
  std::string scrollbar_placement = scrollbar_placement_;
  int radius = radius_;
  int content_inset = content_inset_;
  bool shadow = shadow_;
  v8::Local<v8::Value> value;
  if (HasValue(&dictionary, "content", &value)) {
    std::set<std::string> ids;
    content.emplace();
    if (!ParseNode(args->isolate(), value, &*content, &ids)) {
      args->ThrowTypeError("Invalid NativePanel content");
      return;
    }
  }
  if (HasValue(&dictionary, "theme", &value)) {
    theme.clear();
    if (!ParseTheme(args->isolate(), value, &theme)) {
      args->ThrowTypeError("Invalid NativePanel theme");
      return;
    }
  }
  if (HasValue(&dictionary, "anchorBounds", &value)) {
    anchor.emplace();
    if (!ParseRect(&dictionary, &*anchor)) {
      args->ThrowTypeError("Invalid NativePanel anchorBounds");
      return;
    }
  }
  if (HasValue(&dictionary, "radius", &value) &&
      (!gin::ConvertFromV8(args->isolate(), value, &radius) || radius < 0 ||
       radius > 1000)) {
    args->ThrowTypeError("Invalid NativePanel radius");
    return;
  }
  if (HasValue(&dictionary, "shadow", &value) &&
      !gin::ConvertFromV8(args->isolate(), value, &shadow)) {
    args->ThrowTypeError("Invalid NativePanel shadow");
    return;
  }
  // No native state is changed until all patch fields have been parsed.
  if (HasValue(&dictionary, "contentInset", &value) &&
      (!gin::ConvertFromV8(args->isolate(), value, &content_inset) ||
       content_inset < 0 || content_inset > 64)) {
    args->ThrowTypeError("Invalid NativePanel contentInset");
    return;
  }
  if (HasValue(&dictionary, "backgroundMaterial", &value) &&
      !ParseBackgroundMaterial(args->isolate(), value, &background_material)) {
    args->ThrowTypeError("Invalid NativePanel backgroundMaterial");
    return;
  }
  if (HasValue(&dictionary, "scrollbarPlacement", &value) &&
      !ParseScrollbarPlacement(args->isolate(), value, &scrollbar_placement)) {
    args->ThrowTypeError("Invalid NativePanel scrollbarPlacement");
    return;
  }
  if (content)
    host_->UpdateContent(std::move(*content));
  if (theme != theme_ || radius != radius_ || shadow != shadow_ ||
      content_inset != content_inset_ ||
      background_material != background_material_ ||
      scrollbar_placement != scrollbar_placement_) {
    host_->UpdateAppearance(theme.Clone(), radius, shadow, content_inset,
                            background_material, scrollbar_placement);
    theme_ = std::move(theme);
    radius_ = radius;
    content_inset_ = content_inset;
    shadow_ = shadow;
    background_material_ = std::move(background_material);
    scrollbar_placement_ = std::move(scrollbar_placement);
  }
  if (anchor)
    host_->UpdateAnchor(*anchor);
#endif
}

void NativePanel::Hide() {
#if BUILDFLAG(IS_WIN)
  if (host_)
    host_->Hide();
#endif
}

void NativePanel::Destroy() {
  if (destroyed_)
    return;
  destroyed_ = true;
#if BUILDFLAG(IS_WIN)
  host_.reset();
#endif
  EmitWithoutEvent("closed");
}

bool NativePanel::IsDestroyed() const {
  return destroyed_;
}

base::DictValue NativePanel::GetState() const {
#if BUILDFLAG(IS_WIN)
  if (host_)
    return host_->GetState();
#endif
  return base::DictValue()
      .Set("destroyed", true)
      .Set("visible", false)
      .Set("controls", base::ListValue());
}

void NativePanel::OnAction(base::DictValue details) {
  EmitWithoutEvent("action", std::move(details));
}

void NativePanel::OnDismissed(const std::string& reason) {
  EmitWithoutEvent("dismissed", base::DictValue().Set("reason", reason));
}

void NativePanel::OnClosed() {
  Destroy();
}

v8::Local<v8::FunctionTemplate> NativePanel::GetConstructorTemplate(
    v8::Isolate* isolate) {
  static base::NoDestructor<v8::Global<v8::FunctionTemplate>> cached;
  if (cached->IsEmpty()) {
    cached->Reset(isolate,
                  gin_helper::CreateConstructorTemplate<NativePanel>(
                      isolate, base::BindRepeating(&NativePanel::New),
                      gin_helper::internal::GetEventEmitterTemplate(isolate)));
  }
  return v8::Local<v8::FunctionTemplate>::New(isolate, *cached);
}

v8::Local<v8::Function> NativePanel::GetConstructor(v8::Isolate* isolate) {
  return GetConstructorTemplate(isolate)
      ->GetFunction(isolate->GetCurrentContext())
      .ToLocalChecked();
}

void NativePanel::BuildPrototype(v8::Isolate* isolate,
                                 v8::Local<v8::FunctionTemplate> prototype) {
  prototype->SetClassName(gin::StringToV8(isolate, "NativePanel"));
  gin_helper::ObjectTemplateBuilder(isolate, prototype->PrototypeTemplate())
      .SetMethod<&NativePanel::Show>("show")
      .SetMethod<&NativePanel::Update>("update")
      .SetMethod<&NativePanel::Hide>("hide")
      .SetMethod<&NativePanel::Destroy>("destroy")
      .SetMethod<&NativePanel::IsDestroyed>("isDestroyed")
      .SetMethod<&NativePanel::GetState>("_getState");
}

}  // namespace electron::api

namespace {

void Initialize(v8::Local<v8::Object> exports,
                v8::Local<v8::Value> unused,
                v8::Local<v8::Context> context,
                void* priv) {
  v8::Isolate* isolate = electron::JavascriptEnvironment::GetIsolate();
  auto constructor = electron::api::NativePanel::GetConstructor(isolate);
  gin_helper::Dictionary dictionary(isolate, exports);
  dictionary.Set("NativePanel", constructor);
  gin_helper::Dictionary statics(isolate, constructor);
  statics.SetMethod<&electron::api::NativePanel::IsSupported>("isSupported");
}

}  // namespace

NODE_LINKED_BINDING_CONTEXT_AWARE(electron_browser_native_panel, Initialize)
