// Copyright (c) 2019 Slack Technologies, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "electron/shell/renderer/electron_api_service_impl.h"

#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/strings/string_util.h"
#include "base/trace_event/trace_event.h"
#include "gin/data_object_builder.h"
#include "mojo/public/cpp/system/platform_handle.h"
#include "shell/common/electron_constants.h"
#include "shell/common/gin_converters/blink_converter.h"
#include "shell/common/gin_converters/value_converter.h"
#include "shell/common/heap_snapshot.h"
#include "shell/common/options_switches.h"
#include "shell/common/thread_restrictions.h"
#include "shell/common/v8_util.h"
#include "shell/renderer/electron_ipc_native.h"

#include "base/no_destructor.h"
#include "content/public/renderer/render_thread.h"
#include "shell/renderer/electron_render_frame_observer.h"
#include "shell/renderer/renderer_client_base.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/mojom/frame/user_activation_notification_type.mojom-shared.h"
#include "third_party/blink/public/platform/scheduler/web_agent_group_scheduler.h"
#include "third_party/blink/public/web/blink.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_element.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/web/web_message_port_converter.h"
#include "third_party/blink/public/web/web_node.h"
#include "ui/gfx/geometry/rect.h"
#include "v8/include/v8-context.h"

namespace electron {

namespace {

mojom::RendererStartupDataPtr* GetPendingNewWindowStartupData() {
  // Process-global, no locking: set, RenderFrame creation, and take are all
  // one synchronous call stack inside window.open() on the renderer main
  // thread.
  DCHECK(content::RenderThread::Get())
      << "must be called from the renderer main thread";
  static base::NoDestructor<mojom::RendererStartupDataPtr> pending;
  return pending.get();
}

std::string TrimAsciiWhitespace(std::string_view input) {
  return std::string(base::TrimString(input, base::kWhitespaceASCII,
                                      base::TRIM_ALL));
}

std::vector<std::string> SplitPierceSelector(const std::string& selector) {
  std::vector<std::string> parts;
  size_t start = 0;
  while (start <= selector.size()) {
    size_t pos = selector.find(">>>", start);
    if (pos == std::string::npos) {
      parts.push_back(TrimAsciiWhitespace(selector.substr(start)));
      break;
    }
    parts.push_back(TrimAsciiWhitespace(selector.substr(start, pos - start)));
    start = pos + 3;
  }
  return parts;
}

blink::WebElement QueryInScope(const blink::WebNode& scope,
                               const blink::WebString& selector) {
  if (scope.IsNull() || selector.IsEmpty())
    return blink::WebElement();
  return scope.QuerySelector(selector);
}

blink::WebElement QueryDeepPierce(const blink::WebNode& scope,
                                  const blink::WebString& selector) {
  blink::WebElement match = QueryInScope(scope, selector);
  if (!match.IsNull())
    return match;

  std::vector<blink::WebElement> candidates =
      scope.QuerySelectorAll(blink::WebString::FromUtf8("*"));
  for (blink::WebElement& candidate : candidates) {
    blink::WebNode shadow = candidate.OpenOrClosedShadowRoot();
    if (shadow.IsNull())
      continue;
    blink::WebElement nested = QueryDeepPierce(shadow, selector);
    if (!nested.IsNull())
      return nested;
  }
  return blink::WebElement();
}

blink::WebElement QuerySelectorDeepImpl(blink::WebDocument document,
                                        const std::string& selector,
                                        bool pierce) {
  if (document.IsNull() || selector.empty())
    return blink::WebElement();

  const bool has_pierce_combinator = selector.find(">>>") != std::string::npos;
  if (has_pierce_combinator) {
    std::vector<std::string> parts = SplitPierceSelector(selector);
    if (parts.empty() || parts[0].empty())
      return blink::WebElement();

    blink::WebNode scope = document;
    for (size_t i = 0; i < parts.size(); ++i) {
      if (parts[i].empty())
        return blink::WebElement();
      blink::WebElement match =
          QueryInScope(scope, blink::WebString::FromUtf8(parts[i]));
      if (match.IsNull())
        return blink::WebElement();
      if (i + 1 == parts.size())
        return match;
      blink::WebNode shadow = match.OpenOrClosedShadowRoot();
      if (shadow.IsNull())
        return blink::WebElement();
      scope = shadow;
    }
    return blink::WebElement();
  }

  blink::WebString web_selector = blink::WebString::FromUtf8(selector);
  if (pierce)
    return QueryDeepPierce(document, web_selector);
  return QueryInScope(document, web_selector);
}

float CssScaleForElement(blink::WebElement element) {
  if (element.IsNull())
    return 1.f;
  // GetEffectiveZoom includes device-scale-independent CSS zoom + browser zoom
  // cumulative effects. BoundsInWidget already includes page/pinch scale via
  // FrameToViewport; dividing by effective zoom maps back toward CSS pixels
  // compatible with CDP Input.dispatchMouseEvent.
  const float zoom = element.GetEffectiveZoom();
  return zoom > 0.f ? zoom : 1.f;
}

mojom::DomElementInfoPtr BuildDomElementInfo(blink::WebElement element) {
  if (element.IsNull())
    return nullptr;
  const float css_scale = CssScaleForElement(element);
  auto info = mojom::DomElementInfo::New();
  info->backend_node_id = element.GetDomNodeId();
  info->tag_name = element.TagName().Utf8();
  const gfx::Rect bounds = element.BoundsInWidget();
  info->bounds = gfx::Rect(bounds);
  info->x = static_cast<double>(bounds.x()) / css_scale;
  info->y = static_cast<double>(bounds.y()) / css_scale;
  info->width = static_cast<double>(bounds.width()) / css_scale;
  info->height = static_cast<double>(bounds.height()) / css_scale;
  return info;
}

mojom::DomBoxModelPtr BuildDomBoxModel(blink::WebElement element) {
  if (element.IsNull())
    return nullptr;
  mojom::DomElementInfoPtr info = BuildDomElementInfo(element);
  if (!info)
    return nullptr;
  auto model = mojom::DomBoxModel::New();
  model->backend_node_id = info->backend_node_id;
  model->x = info->x;
  model->y = info->y;
  model->width = info->width;
  model->height = info->height;
  return model;
}

}  // namespace

ElectronApiServiceImpl::~ElectronApiServiceImpl() = default;

ElectronApiServiceImpl::ElectronApiServiceImpl(
    content::RenderFrame* render_frame,
    RendererClientBase* renderer_client)
    : content::RenderFrameObserver(render_frame),
      content::RenderFrameObserverTracker<ElectronApiServiceImpl>(render_frame),
      renderer_client_(renderer_client) {
  registry_.AddInterface<mojom::ElectronRenderer>(base::BindRepeating(
      &ElectronApiServiceImpl::BindTo, base::Unretained(this)));
  // Associated with content.mojom.Frame, so SetStartupData() arrives before
  // the CommitNavigation that follows it — i.e. before DidCreateScriptContext.
  render_frame->GetAssociatedInterfaceRegistry()
      ->AddInterface<mojom::ElectronFrameStartup>(
          base::BindRepeating(&ElectronApiServiceImpl::BindFrameStartupReceiver,
                              base::Unretained(this)));

  // window.open() popup's about:blank fires DidCreateScriptContext before
  // any push can land; the browser attaches its startup data to the
  // CreateNewWindowReply and SetPendingCreateNewWindowStartupData() stashes it
  // for us on this same call stack. The first real navigation replaces it.
  startup_data_ = std::exchange(*GetPendingNewWindowStartupData(), nullptr);
}

// static
void ElectronApiServiceImpl::SetPendingNewWindowStartupData(
    mojom::RendererStartupDataPtr data) {
  *GetPendingNewWindowStartupData() = std::move(data);
}

void ElectronApiServiceImpl::BindFrameStartupReceiver(
    mojo::PendingAssociatedReceiver<mojom::ElectronFrameStartup> receiver) {
  if (frame_startup_receiver_.is_bound())
    frame_startup_receiver_.reset();
  frame_startup_receiver_.Bind(std::move(receiver));
}

void ElectronApiServiceImpl::SetStartupData(
    mojom::RendererStartupDataPtr data) {
  startup_data_ = std::move(data);
}

void ElectronApiServiceImpl::BindTo(
    mojo::PendingReceiver<mojom::ElectronRenderer> receiver) {
  if (document_created_) {
    if (receiver_.is_bound())
      receiver_.reset();

    receiver_.Bind(std::move(receiver));
    receiver_.set_disconnect_handler(base::BindOnce(
        &ElectronApiServiceImpl::OnConnectionError, GetWeakPtr()));
  } else {
    pending_receiver_ = std::move(receiver);
  }
}

void ElectronApiServiceImpl::OnInterfaceRequestForFrame(
    const std::string& interface_name,
    mojo::ScopedMessagePipeHandle* interface_pipe) {
  registry_.TryBindInterface(interface_name, interface_pipe);
}

void ElectronApiServiceImpl::DidCreateDocumentElement() {
  document_created_ = true;

  if (pending_receiver_) {
    if (receiver_.is_bound())
      receiver_.reset();

    receiver_.Bind(std::move(pending_receiver_));
    receiver_.set_disconnect_handler(base::BindOnce(
        &ElectronApiServiceImpl::OnConnectionError, GetWeakPtr()));
  }
}

void ElectronApiServiceImpl::OnDestruct() {
  delete this;
}

void ElectronApiServiceImpl::OnConnectionError() {
  if (receiver_.is_bound())
    receiver_.reset();
}

void ElectronApiServiceImpl::Message(bool internal,
                                     const std::string& channel,
                                     blink::CloneableMessage arguments) {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame)
    return;

  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  v8::HandleScope handle_scope(isolate);

  v8::Local<v8::Context> context = renderer_client_->GetContext(frame, isolate);
  v8::Context::Scope context_scope(context);

  v8::Local<v8::Value> args = gin::ConvertToV8(isolate, arguments);

  ipc_native::EmitIPCEvent(isolate, context, internal, channel, {}, args);
}

void ElectronApiServiceImpl::ReceivePostMessage(
    const std::string& channel,
    blink::TransferableMessage message) {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame)
    return;

  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  v8::HandleScope handle_scope(isolate);

  v8::Local<v8::Context> context = renderer_client_->GetContext(frame, isolate);
  v8::Context::Scope context_scope(context);

  v8::Local<v8::Value> message_value = DeserializeV8Value(isolate, message);

  std::vector<v8::Local<v8::Value>> ports;
  for (auto& port : message.ports) {
    ports.emplace_back(
        blink::WebMessagePortConverter::EntangleAndInjectMessagePortChannel(
            isolate, context, std::move(port)));
  }

  std::vector<v8::Local<v8::Value>> args = {message_value};

  ipc_native::EmitIPCEvent(isolate, context, false, channel, ports,
                           gin::ConvertToV8(isolate, args));
}

void ElectronApiServiceImpl::TakeHeapSnapshot(
    mojo::ScopedHandle file,
    TakeHeapSnapshotCallback callback) {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame)
    return;

  ScopedAllowBlockingForElectron allow_blocking;

  base::ScopedPlatformFile platform_file;
  if (mojo::UnwrapPlatformFile(std::move(file), &platform_file) !=
      MOJO_RESULT_OK) {
    LOG(ERROR) << "Unable to get the file handle from mojo.";
    std::move(callback).Run(false);
    return;
  }
  base::File base_file(std::move(platform_file));

  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  bool success = electron::TakeHeapSnapshot(isolate, &base_file);

  std::move(callback).Run(success);
}

void ElectronApiServiceImpl::QuerySelectorDeep(
    const std::string& selector,
    bool pierce,
    bool scroll_into_view,
    QuerySelectorDeepCallback callback) {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame) {
    std::move(callback).Run(false, nullptr);
    return;
  }

  blink::WebElement element =
      QuerySelectorDeepImpl(frame->GetDocument(), selector, pierce);
  if (element.IsNull()) {
    std::move(callback).Run(false, nullptr);
    return;
  }

  if (scroll_into_view)
    element.ScrollIntoViewIfNeeded();

  std::move(callback).Run(true, BuildDomElementInfo(element));
}

void ElectronApiServiceImpl::GetNodeBoxModel(
    int32_t backend_node_id,
    bool scroll_into_view,
    GetNodeBoxModelCallback callback) {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame) {
    std::move(callback).Run(false, nullptr);
    return;
  }

  blink::WebNode node = blink::WebNode::FromDomNodeId(backend_node_id);
  if (node.IsNull() || !node.IsElementNode()) {
    std::move(callback).Run(false, nullptr);
    return;
  }

  blink::WebElement element = node.DynamicTo<blink::WebElement>();
  if (element.IsNull()) {
    std::move(callback).Run(false, nullptr);
    return;
  }

  // Ensure the node still belongs to this frame's document.
  if (element.GetDocument() != frame->GetDocument()) {
    std::move(callback).Run(false, nullptr);
    return;
  }

  if (scroll_into_view)
    element.ScrollIntoViewIfNeeded();

  std::move(callback).Run(true, BuildDomBoxModel(element));
}

}  // namespace electron
