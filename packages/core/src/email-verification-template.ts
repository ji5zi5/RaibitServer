function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] || character);
}

export const EMAIL_VERIFICATION_ORGANIZATION = 'Incheon Science High School · RAIBIT';
export const EMAIL_VERIFICATION_SITE_URL = 'https://raibit.kr';
export const EMAIL_VERIFICATION_CONTACT_EMAIL = 'ishsraibit@gmail.com';

export function renderEmailVerificationHtml(input: { appName: string; code: string; minutes: number }) {
  const appName = escapeHtml(input.appName);
  const code = escapeHtml(input.code);
  const minutes = input.minutes;

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${appName} 이메일 인증</title>
</head>
<body style="margin:0;padding:0;background:#edf2ef;color:#17251c;font-family:Arial,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${appName} 인증 코드 ${code} · 약 ${minutes}분 동안 사용할 수 있습니다.</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:#edf2ef;">
    <tr><td align="center" style="padding:36px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="border-collapse:separate;width:100%;max-width:600px;background:#ffffff;border:1px solid #dce8de;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px 36px;background:#14221a;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
            <td width="42" height="42" align="center" valign="middle" style="width:42px;height:42px;background:#68df88;border-radius:11px;color:#102018;font-size:26px;font-weight:800;line-height:42px;">R</td>
            <td style="padding-left:13px;color:#f4f8f4;font-size:19px;font-weight:800;letter-spacing:0.3px;">${appName}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:40px 36px 36px;">
          <p style="margin:0 0 12px;color:#398751;font-size:13px;font-weight:700;letter-spacing:1.2px;">EMAIL VERIFICATION</p>
          <h1 style="margin:0 0 18px;color:#17251c;font-size:29px;line-height:1.4;font-weight:800;">이메일 인증을 완료해 주세요</h1>
          <p style="margin:0 0 30px;color:#46564b;font-size:16px;line-height:1.8;">안녕하세요. 가입을 계속하려면 아래의 6자리 코드를<br>가입 화면에 입력해 주세요.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;background:#f0f9f2;border:1px solid #cdebd4;border-radius:12px;">
            <tr><td align="center" style="padding:24px 12px 22px;">
              <p style="margin:0 0 10px;color:#3e6f4d;font-size:13px;font-weight:700;">이메일 인증 코드</p>
              <p style="margin:0;color:#143b22;font-family:Arial,sans-serif;font-size:36px;font-weight:800;letter-spacing:8px;line-height:1.3;white-space:nowrap;">${code}</p>
            </td></tr>
          </table>
          <p style="margin:22px 0 0;color:#53645a;font-size:14px;line-height:1.7;text-align:center;">이 코드는 약 <strong>${minutes}분</strong> 후 만료됩니다.</p>
        </td></tr>
        <tr><td style="padding:24px 36px 28px;border-top:1px solid #e6ece7;background:#fafcfb;">
          <p style="margin:0 0 12px;color:#53645a;font-size:13px;line-height:1.7;">본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다.</p>
          <p style="margin:0 0 10px;color:#314338;font-size:13px;font-weight:700;line-height:1.6;">${EMAIL_VERIFICATION_ORGANIZATION}</p>
          <p style="margin:0 0 5px;color:#718077;font-size:12px;line-height:1.6;">사이트 <a href="${EMAIL_VERIFICATION_SITE_URL}" style="color:#287c43;text-decoration:underline;">${EMAIL_VERIFICATION_SITE_URL}</a></p>
          <p style="margin:0;color:#718077;font-size:12px;line-height:1.6;">문의 이메일 <a href="mailto:${EMAIL_VERIFICATION_CONTACT_EMAIL}" style="color:#287c43;text-decoration:underline;">${EMAIL_VERIFICATION_CONTACT_EMAIL}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
