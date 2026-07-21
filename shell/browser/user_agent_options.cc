// Copyright (c) 2026 ChengHoward.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/user_agent_options.h"

#include <utility>
#include <vector>

#include "gin/arguments.h"
#include "gin/converter.h"
#include "shell/common/gin_converters/std_converter.h"
#include "shell/common/gin_helper/dictionary.h"

namespace electron {
namespace {

bool ParseBrandList(const gin_helper::Dictionary& parent,
                    const char* key,
                    blink::UserAgentBrandList* out) {
  v8::Local<v8::Value> value;
  if (!parent.Get(key, &value) || !value->IsArray())
    return false;

  v8::Local<v8::Array> arr = value.As<v8::Array>();
  v8::Isolate* isolate = parent.isolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  blink::UserAgentBrandList list;
  for (uint32_t i = 0; i < arr->Length(); ++i) {
    v8::Local<v8::Value> item;
    if (!arr->Get(context, i).ToLocal(&item) || !item->IsObject())
      return false;
    gin_helper::Dictionary brand_dict;
    if (!gin::ConvertFromV8(isolate, item, &brand_dict))
      return false;
    blink::UserAgentBrandVersion bv;
    if (!brand_dict.Get("brand", &bv.brand) ||
        !brand_dict.Get("version", &bv.version)) {
      return false;
    }
    list.push_back(std::move(bv));
  }
  *out = std::move(list);
  return true;
}

}  // namespace

bool ParseUserAgentMetadata(const gin_helper::Dictionary& dict,
                            const blink::UserAgentMetadata& defaults,
                            blink::UserAgentMetadata* out,
                            std::string* error) {
  *out = defaults;

  blink::UserAgentBrandList brands;
  if (ParseBrandList(dict, "brands", &brands)) {
    out->brand_version_list = std::move(brands);
  } else if (dict.Has("brands")) {
    *error = "userAgentMetadata.brands must be an array of {brand, version}";
    return false;
  }

  blink::UserAgentBrandList full_list;
  if (ParseBrandList(dict, "fullVersionList", &full_list)) {
    out->brand_full_version_list = std::move(full_list);
  } else if (dict.Has("fullVersionList")) {
    *error =
        "userAgentMetadata.fullVersionList must be an array of {brand, version}";
    return false;
  }

  dict.Get("fullVersion", &out->full_version);
  dict.Get("platform", &out->platform);
  dict.Get("platformVersion", &out->platform_version);
  dict.Get("architecture", &out->architecture);
  dict.Get("model", &out->model);
  dict.Get("mobile", &out->mobile);
  dict.Get("bitness", &out->bitness);
  dict.Get("wow64", &out->wow64);

  v8::Local<v8::Value> form_factors_val;
  if (dict.Get("formFactors", &form_factors_val)) {
    if (!form_factors_val->IsArray()) {
      *error = "userAgentMetadata.formFactors must be an array of strings";
      return false;
    }
    v8::Local<v8::Array> arr = form_factors_val.As<v8::Array>();
    v8::Isolate* isolate = dict.isolate();
    v8::Local<v8::Context> context = isolate->GetCurrentContext();
    std::vector<std::string> form_factors;
    for (uint32_t i = 0; i < arr->Length(); ++i) {
      v8::Local<v8::Value> item;
      if (!arr->Get(context, i).ToLocal(&item))
        return false;
      std::string factor;
      if (!gin::ConvertFromV8(isolate, item, &factor)) {
        *error = "userAgentMetadata.formFactors must be an array of strings";
        return false;
      }
      form_factors.push_back(std::move(factor));
    }
    out->form_factors = std::move(form_factors);
  }

  return true;
}

bool ParseUserAgentOptions(gin::Arguments* args,
                           const blink::UserAgentMetadata& defaults,
                           UserAgentOptions* out,
                           std::string* error) {
  if (args->Length() == 0)
    return true;

  v8::Local<v8::Value> next;
  if (!args->GetNext(&next))
    return true;

  // Legacy: session.setUserAgent(ua, acceptLanguages:string)
  if (next->IsString()) {
    std::string accept_language;
    if (!gin::ConvertFromV8(args->isolate(), next, &accept_language)) {
      *error = "Invalid acceptLanguages";
      return false;
    }
    out->accept_language = std::move(accept_language);
    return true;
  }

  if (!next->IsObject()) {
    *error = "Expected string acceptLanguages or options object";
    return false;
  }

  gin_helper::Dictionary dict;
  if (!gin::ConvertFromV8(args->isolate(), next, &dict)) {
    *error = "Invalid options object";
    return false;
  }

  dict.Get("platform", &out->platform);

  std::string accept_language;
  if (dict.Get("acceptLanguage", &accept_language) ||
      dict.Get("acceptLanguages", &accept_language)) {
    out->accept_language = std::move(accept_language);
  }

  v8::Local<v8::Value> metadata_val;
  if (dict.Get("userAgentMetadata", &metadata_val)) {
    if (metadata_val->IsNullOrUndefined()) {
      out->metadata_policy = UserAgentMetadataPolicy::kDisabled;
    } else if (metadata_val->IsObject()) {
      gin_helper::Dictionary metadata_dict;
      if (!gin::ConvertFromV8(args->isolate(), metadata_val, &metadata_dict)) {
        *error = "Invalid userAgentMetadata object";
        return false;
      }
      blink::UserAgentMetadata metadata;
      if (!ParseUserAgentMetadata(metadata_dict, defaults, &metadata, error))
        return false;
      out->metadata_policy = UserAgentMetadataPolicy::kCustom;
      out->user_agent_metadata = std::move(metadata);
    } else {
      *error = "userAgentMetadata must be an object or null";
      return false;
    }
  }

  return true;
}

}  // namespace electron
