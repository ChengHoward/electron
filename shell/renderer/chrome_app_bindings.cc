// Copyright (c) 2026 cloudbypass.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/renderer/chrome_app_bindings.h"

#include <tuple>

#include "content/public/renderer/chrome_object_extensions_utils.h"
#include "gin/converter.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-microtask-queue.h"
#include "v8/include/v8-object.h"
#include "v8/include/v8-primitive.h"

namespace electron {
namespace {

void EmptySetter(v8::Local<v8::Name> name,
                 v8::Local<v8::Value> value,
                 const v8::PropertyCallbackInfo<v8::Boolean>& info) {}

void IsInstalledGetter(v8::Local<v8::Name> name,
                       const v8::PropertyCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(false);
}

void GetDetails(const v8::FunctionCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().SetNull();
}

void GetIsInstalled(const v8::FunctionCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(false);
}

void RunningState(const v8::FunctionCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(
      v8::String::NewFromUtf8Literal(info.GetIsolate(), "cannot_run"));
}

void InvokeInstallState(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  if (info.Data().IsEmpty() || !info.Data()->IsFunction()) {
    return;
  }
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  v8::Local<v8::Value> state =
      v8::String::NewFromUtf8Literal(isolate, "not_installed");
  v8::Local<v8::Value> argv[] = {state};
  std::ignore = info.Data().As<v8::Function>()->Call(
      context, v8::Undefined(isolate), 1, argv);
}

void InstallState(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsFunction()) {
    return;
  }
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  v8::Local<v8::Function> trampoline;
  if (!v8::Function::New(context, InvokeInstallState, info[0], 0,
                         v8::ConstructorBehavior::kThrow)
           .ToLocal(&trampoline)) {
    return;
  }
  isolate->EnqueueMicrotask(trampoline);
}

void SetMethod(v8::Local<v8::Context> context,
               v8::Local<v8::Object> object,
               const char* name,
               v8::FunctionCallback callback,
               int length) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  v8::Local<v8::Function> function;
  if (!v8::Function::New(context, callback, {}, length,
                         v8::ConstructorBehavior::kThrow)
           .ToLocal(&function)) {
    return;
  }
  v8::Local<v8::String> key = gin::StringToSymbol(isolate, name);
  function->SetName(key);
  object->Set(context, key, function).Check();
}

}  // namespace

void InstallChromeApp(v8::Local<v8::Context> context) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  if (!isolate || context.IsEmpty()) {
    return;
  }

  v8::HandleScope handle_scope(isolate);
  v8::MicrotasksScope microtasks_scope(
      isolate, context->GetMicrotaskQueue(),
      v8::MicrotasksScope::kDoNotRunMicrotasks);
  v8::Context::Scope context_scope(context);

  v8::Local<v8::Object> chrome =
      content::GetOrCreateChromeObject(isolate, context);
  v8::Local<v8::String> app_name = gin::StringToSymbol(isolate, "app");
  v8::Local<v8::Value> existing;
  if (chrome->Get(context, app_name).ToLocal(&existing) &&
      existing->IsObject()) {
    return;
  }

  v8::Local<v8::Object> app = v8::Object::New(isolate);
  v8::Local<v8::String> installed_name =
      gin::StringToSymbol(isolate, "isInstalled");
  if (!app->SetNativeDataProperty(context, installed_name, IsInstalledGetter,
                                  EmptySetter)
           .FromMaybe(false)) {
    return;
  }

  SetMethod(context, app, "getDetails", GetDetails, 0);
  SetMethod(context, app, "getIsInstalled", GetIsInstalled, 0);
  SetMethod(context, app, "runningState", RunningState, 0);
  SetMethod(context, app, "installState", InstallState, 1);
  chrome->Set(context, app_name, app).Check();
}

}  // namespace electron
