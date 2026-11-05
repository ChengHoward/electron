// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.
#include "shell/browser/ui/views/certificate_viewer.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/strings/utf_string_conversions.h"
#include "base/supports_user_data.h"
#include "chrome/browser/ui/webui/certificate_viewer/certificate_viewer_resources_util.h"
#include "chrome/common/net/certificate_viewer_model.h"
#include "content/public/browser/file_select_listener.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "net/cert/x509_certificate.h"
#include "shell/browser/ui/views/certificate_viewer_exporter.h"
#include "ui/base/mojom/ui_base_types.mojom-shared.h"
#include "ui/views/controls/webview/web_dialog_view.h"
#include "ui/views/widget/desktop_aura/desktop_native_widget_aura.h"
#include "ui/views/widget/widget.h"
#include "ui/views/win/hwnd_util.h"
#include "ui/web_dialogs/web_dialog_delegate.h"
#include "ui/web_dialogs/web_dialog_ui.h"

namespace electron {
namespace {
using Model = x509_certificate_model::X509CertificateModel;
constexpr char kCertificateViewerData[] = "Electron.InternalCertificateViewer";

class CertificateHandler final : public content::WebUIMessageHandler {
 public:
  explicit CertificateHandler(std::vector<Model> certs)
      : certs_(std::move(certs)) {}
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback(
        "requestCertificateFields",
        base::BindRepeating(&CertificateHandler::Fields,
                            base::Unretained(this)));
    web_ui()->RegisterMessageCallback(
        "exportCertificate", base::BindRepeating(&CertificateHandler::Export,
                                                 base::Unretained(this)));
  }

 private:
  void Fields(const base::ListValue& args) {
    if (args.size() != 2 || !args[0].is_string() || !args[1].is_int())
      return;
    const int index = args[1].GetInt();
    if (index < 0 || static_cast<size_t>(index) >= certs_.size())
      return;
    AllowJavascript();
    ResolveJavascriptCallback(
        args[0],
        x509_certificate_model::CertificateViewerFields(certs_[index]));
  }
  void Export(const base::ListValue& args) {
    if (args.size() != 1 || !args[0].is_int())
      return;
    const int index = args[0].GetInt();
    if (index < 0 || static_cast<size_t>(index) >= certs_.size())
      return;
    std::vector<bssl::UniquePtr<CRYPTO_BUFFER>> buffers;
    for (size_t i = index; i < certs_.size(); ++i)
      buffers.push_back(bssl::UpRef(certs_[i].cert_buffer()));
    ShowElectronCertExportDialog(
        web_ui()->GetWebContents(),
        web_ui()->GetWebContents()->GetTopLevelNativeWindow(),
        std::move(buffers), certs_[index].GetTitle());
  }
  std::vector<Model> certs_;
};

class DialogNavigation final
    : public ui::WebDialogWebContentsDelegate::WebContentsHandler {
 public:
  content::WebContents* OpenURLFromTab(
      content::BrowserContext*,
      content::WebContents*,
      const content::OpenURLParams&,
      base::OnceCallback<void(content::NavigationHandle&)>) override {
    return nullptr;
  }
  void AddNewContents(content::BrowserContext*,
                      content::WebContents*,
                      std::unique_ptr<content::WebContents>,
                      const GURL&,
                      WindowOpenDisposition,
                      const blink::mojom::WindowFeatures&,
                      bool) override {}
  void RunFileChooser(content::RenderFrameHost*,
                      scoped_refptr<content::FileSelectListener> listener,
                      const blink::mojom::FileChooserParams&) override {
    listener->FileSelectionCanceled();
  }
};

class CertificateDialog final : public ui::WebDialogDelegate,
                                public content::WebContentsObserver {
 public:
  CertificateDialog(content::WebContents* source,
                    net::X509Certificate* certificate,
                    base::OnceClosure closed)
      : content::WebContentsObserver(source) {
    std::vector<Model> models;
    for (auto& buffer : certificate->CopyCertBuffers())
      models.emplace_back(std::move(buffer));
    auto args = x509_certificate_model::CertificateViewerDialogArgs(models);
    set_dialog_title(
        base::UTF8ToUTF16(*args.FindStringByDottedPath("general.title")));
    set_dialog_args(base::WriteJson(args).value_or("{}"));
    set_dialog_content_url(GURL("chrome://view-cert/"));
    set_dialog_size(gfx::Size(544, 628));
    set_minimum_dialog_size(gfx::Size(420, 420));
    set_can_resize(true);
    set_can_close(true);
    set_dialog_modal_type(ui::mojom::ModalType::kNone);
    set_dialog_frame_kind(FrameKind::kDialog);
    AddWebUIMessageHandler(
        std::make_unique<CertificateHandler>(std::move(models)));
    RegisterOnDialogClosedCallback(
        base::BindOnce([](base::OnceClosure callback,
                          const std::string&) { std::move(callback).Run(); },
                       std::move(closed)));
  }
  void SetWidget(base::WeakPtr<views::Widget> widget) {
    widget_ = std::move(widget);
  }
  void DidStartNavigation(content::NavigationHandle* navigation) override {
    if (navigation->IsInPrimaryMainFrame())
      Close();
  }
  void WebContentsDestroyed() override { Close(); }
  void DidChangeVisibleSecurityState() override { Close(); }

 private:
  void Close() {
    if (widget_ && !widget_->IsClosed())
      widget_->Close();
  }
  base::WeakPtr<views::Widget> widget_;
};

}  // namespace

bool IsCertificateViewer(content::WebContents* contents) {
  return contents && contents->GetUserData(kCertificateViewerData);
}

std::unique_ptr<content::WebUIController> CreateCertificateViewerUI(
    content::WebUI* web_ui) {
  // Only the native delegate supplies certificate arguments and handlers.
  // A direct navigation may load these static resources but receives no data.
  certificate_viewer::AddDataSource(
      web_ui->GetWebContents()->GetBrowserContext());
  return std::make_unique<ui::WebDialogUI>(web_ui);
}

CertificateViewerHandle ShowCertificateViewer(content::WebContents* source,
                                              views::Widget* parent,
                                              net::X509Certificate* certificate,
                                              base::OnceClosure closed) {
  auto* delegate =
      new CertificateDialog(source, certificate, std::move(closed));
  auto* view = new views::WebDialogView(source->GetBrowserContext(), delegate,
                                        std::make_unique<DialogNavigation>());
  // Dialog frames only expose a native draggable caption when opted in.
  view->set_draggable(true);
  auto* web_view = static_cast<views::WebView*>(view->children().front().get());
  web_view->GetWebContents()->SetUserData(
      kCertificateViewerData, std::make_unique<base::SupportsUserData::Data>());
  view->set_use_desktop_widget_override(true);
  auto* widget = new views::Widget;
  widget->set_frame_type(views::Widget::FrameType::kForceCustom);
  auto params = views::DialogDelegate::GetDialogWidgetInitParams(
      view, parent->GetNativeWindow(), parent->GetNativeView(), gfx::Rect());
  // Electron otherwise embeds this dialog in the owner's NativeWidgetAura.
  // A dedicated desktop widget supplies an independent HWND and activation.
  params.native_widget = new views::DesktopNativeWidgetAura(widget);
  params.child = false;
  widget->Init(std::move(params));
  delegate->SetWidget(widget->GetWeakPtr());
  widget->Show();
  return {widget->GetWeakPtr(), view->web_contents()->GetWeakPtr()};
}

void InspectCertificateViewer(const CertificateViewerHandle& handle,
                              base::OnceCallback<void(base::Value)> callback) {
  if (!handle.widget || handle.widget->IsClosed() || !handle.contents) {
    std::move(callback).Run(base::Value(base::DictValue()));
    return;
  }
  const auto rect = [](const gfx::Rect& r) {
    return base::DictValue()
        .Set("x", r.x())
        .Set("y", r.y())
        .Set("width", r.width())
        .Set("height", r.height());
  };
  auto state =
      base::DictValue()
          .Set("windowHandle", std::to_string(reinterpret_cast<uintptr_t>(
                                   views::HWNDForWidget(handle.widget.get()))))
          .Set("bounds", rect(handle.widget->GetWindowBoundsInScreen()))
          .Set("contentBounds", rect(handle.contents->GetContainerBounds()))
          .Set("url", handle.contents->GetLastCommittedURL().spec());
  handle.contents->GetPrimaryMainFrame()->ExecuteJavaScriptForTests(
      uR"JS((() => {
    const bounds = e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
    const all=[...document.querySelectorAll('*')];
    for(let i=0;i<all.length;i++) if(all[i].shadowRoot) all.push(...all[i].shadowRoot.querySelectorAll('*'));
    return {title:document.title,language:document.documentElement.lang,direction:document.documentElement.dir,
      process:typeof process,require:typeof require,chromeSend:typeof chrome.send,hostPreload:typeof globalThis.__nativeUiHostPreload,
      elements:[...document.querySelectorAll('[id]')].filter(e=>e.getBoundingClientRect().height).map(e=>({id:e.id,text:e.textContent,bounds:bounds(e),scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,scrollTop:e.scrollTop})),
      items:all.filter(e=>e.localName==='cr-tree-item').map(e=>({label:e.label,expanded:e.expanded,selected:e.selected,detail:e.detail?.payload||{},bounds:bounds(e.shadowRoot.querySelector('.tree-row,#row')||e)}))};
  })())JS",
      base::BindOnce(
          [](base::DictValue state,
             base::OnceCallback<void(base::Value)> callback, base::Value dom) {
            state.Set("dom", std::move(dom));
            std::move(callback).Run(base::Value(std::move(state)));
          },
          std::move(state), std::move(callback)),
      0);
}
}  // namespace electron
