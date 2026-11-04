// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/ui/views/native_page_info.h"

#include <string>
#include <utility>
#include "base/i18n/time_formatting.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/common/net/x509_certificate_model.h"
#include "chrome/grit/generated_resources.h"
#include "components/strings/grit/components_strings.h"
#include "net/cert/x509_certificate.h"
#include "third_party/boringssl/src/include/openssl/pool.h"
#include "ui/base/l10n/l10n_util.h"
#include "ui/strings/grit/ui_strings.h"

namespace electron {
namespace {
std::string Localized(int id) {
  return l10n_util::GetStringUTF8(id);
}
std::string Field(x509_certificate_model::OptionalStringOrError value) {
  if (auto* text = std::get_if<std::string>(&value))
    return *text;
  return Localized(
      std::holds_alternative<x509_certificate_model::NotPresent>(value)
          ? IDS_CERT_INFO_FIELD_NOT_PRESENT
          : IDS_CERT_DUMP_ERROR);
}
}  // namespace

base::DictValue NativePageInfoPresentation(net::X509Certificate* certificate,
                                           std::string_view security) {
  base::DictValue result;
  const bool secure = security == "secure";
  const bool mixed = security == "mixed-content";
  result.Set("summary",
             Localized(secure  ? IDS_PAGE_INFO_SECURE_SUMMARY
                       : mixed ? IDS_PAGE_INFO_MIXED_CONTENT_SUMMARY_SHORT
                               : IDS_PAGE_INFO_NOT_SECURE_SUMMARY_SHORT));
  result.Set("description",
             Localized(secure  ? IDS_PAGE_INFO_SECURE_DETAILS
                       : mixed ? IDS_PAGE_INFO_MIXED_CONTENT_DETAILS
                       : security == "certificate-error"
                           ? IDS_PAGE_INFO_INVALID_CERTIFICATE_DESCRIPTION
                           : IDS_PAGE_INFO_NOT_SECURE_DETAILS));
  static constexpr struct {
    const char* key;
    int id;
  } kStrings[] = {
      {"security", IDS_PAGE_INFO_SECURITY_SUBPAGE_HEADER},
      {"settings", IDS_PAGE_INFO_SITE_SETTINGS_LINK},
      {"certificate", IDS_PAGE_INFO_CERTIFICATE_IS_VALID},
      {"invalidCertificate", IDS_PAGE_INFO_CERTIFICATE_DETAILS},
      {"learnMore", IDS_LEARN_MORE},
      {"close", IDS_CLOSE},
      {"back", IDS_APP_ACCNAME_BACK},
      {"general", IDS_CERT_INFO_GENERAL_TAB_LABEL},
      {"details", IDS_CERT_INFO_DETAILS_TAB_LABEL},
      {"subject", IDS_CERT_INFO_SUBJECT_GROUP},
      {"issuer", IDS_CERT_INFO_ISSUER_GROUP},
      {"cn", IDS_CERT_INFO_COMMON_NAME_LABEL},
      {"organization", IDS_CERT_INFO_ORGANIZATION_LABEL},
      {"unit", IDS_CERT_INFO_ORGANIZATIONAL_UNIT_LABEL},
      {"validity", IDS_CERT_INFO_VALIDITY_GROUP},
      {"issuedOn", IDS_CERT_INFO_ISSUED_ON_LABEL},
      {"expiresOn", IDS_CERT_INFO_EXPIRES_ON_LABEL},
      {"fingerprints", IDS_CERT_INFO_FINGERPRINTS_GROUP},
      {"sha256", IDS_CERT_INFO_SHA256_FINGERPRINT_LABEL},
      {"spki", IDS_CERT_INFO_SHA256_SPKI_FINGERPRINT_LABEL},
      {"hierarchy", IDS_CERT_DETAILS_CERTIFICATE_HIERARCHY_LABEL},
      {"fields", IDS_CERT_DETAILS_CERTIFICATE_FIELDS_LABEL},
  };
  for (const auto& entry : kStrings)
    result.Set(entry.key, Localized(entry.id));
  if (!certificate)
    return result;
  base::ListValue chain;
  auto add = [&](CRYPTO_BUFFER* buffer) {
    x509_certificate_model::X509CertificateModel model(bssl::UpRef(buffer));
    base::DictValue item;
    item.Set("title", model.GetTitle());
    item.Set("sha256", model.HashCertSHA256());
    if (model.is_valid()) {
      item.Set("subjectCN", Field(model.GetSubjectCommonName()));
      item.Set("subjectO", Field(model.GetSubjectOrgName()));
      item.Set("subjectOU", Field(model.GetSubjectOrgUnitName()));
      item.Set("issuerCN", Field(model.GetIssuerCommonName()));
      item.Set("issuerO", Field(model.GetIssuerOrgName()));
      item.Set("issuerOU", Field(model.GetIssuerOrgUnitName()));
      item.Set("spki", model.HashSpkiSHA256());
      base::Time issued, expires;
      if (model.GetTimes(&issued, &expires)) {
        item.Set("issuedOn", base::UTF16ToUTF8(
                                 base::TimeFormatFriendlyDateAndTime(issued)));
        item.Set(
            "expiresOn",
            base::UTF16ToUTF8(base::TimeFormatFriendlyDateAndTime(expires)));
      }
      base::ListValue fields;
      auto field = [&](int label, std::string value) {
        fields.Append(base::DictValue()
                          .Set("label", Localized(label))
                          .Set("value", std::move(value)));
      };
      field(IDS_CERT_DETAILS_VERSION, model.GetVersion());
      field(IDS_CERT_DETAILS_SERIAL_NUMBER, model.GetSerialNumberHexified());
      field(IDS_CERT_DETAILS_ISSUER, Field(model.GetIssuerName()));
      field(IDS_CERT_DETAILS_SUBJECT, Field(model.GetSubjectName()));
      field(IDS_CERT_DETAILS_CERTIFICATE_SIG_ALG,
            model.ProcessSecAlgorithmSignature());
      field(IDS_CERT_DETAILS_SUBJECT_KEY_ALG,
            model.ProcessSecAlgorithmSubjectPublicKey());
      field(IDS_CERT_DETAILS_SUBJECT_KEY, model.ProcessSubjectPublicKeyInfo());
      for (const auto& extension : model.GetExtensions("", ""))
        fields.Append(base::DictValue()
                          .Set("label", extension.name)
                          .Set("value", extension.value));
      field(IDS_CERT_DETAILS_CERTIFICATE_SIG_VALUE,
            model.ProcessRawBitsSignatureWrap());
      item.Set("fields", std::move(fields));
    }
    chain.Append(std::move(item));
  };
  add(certificate->cert_buffer());
  for (const auto& intermediate : certificate->intermediate_buffers())
    add(intermediate.get());
  result.Set("certificateTitle",
             base::UTF16ToUTF8(l10n_util::GetStringFUTF16(
                 IDS_CERT_INFO_DIALOG_TITLE,
                 base::UTF8ToUTF16(certificate->subject().common_name))));
  result.Set("chain", std::move(chain));
  return result;
}
}  // namespace electron
