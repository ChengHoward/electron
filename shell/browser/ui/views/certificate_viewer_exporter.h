// Copyright 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.
#ifndef ELECTRON_SHELL_BROWSER_UI_VIEWS_CERTIFICATE_VIEWER_EXPORTER_H_
#define ELECTRON_SHELL_BROWSER_UI_VIEWS_CERTIFICATE_VIEWER_EXPORTER_H_
#include <string>
#include <vector>
#include "base/files/file_path.h"
#include "third_party/boringssl/src/include/openssl/pool.h"
#include "ui/shell_dialogs/select_file_dialog.h"
namespace content {
class WebContents;
}
namespace electron {
void ShowCertSelectFileDialog(ui::SelectFileDialog* dialog,
                              ui::SelectFileDialog::Type type,
                              const base::FilePath& path,
                              gfx::NativeWindow parent);
void ShowElectronCertExportDialog(
    content::WebContents* contents,
    gfx::NativeWindow parent,
    std::vector<bssl::UniquePtr<CRYPTO_BUFFER>> certs,
    const std::string& title);
}  // namespace electron
#endif  // ELECTRON_SHELL_BROWSER_UI_VIEWS_CERTIFICATE_VIEWER_EXPORTER_H_
