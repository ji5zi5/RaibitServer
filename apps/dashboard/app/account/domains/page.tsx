import { redirect } from 'next/navigation';
import { ConsoleShell } from '../../../components/console-ui';
import { dashboardApiContext, getJson } from '../../../lib/api';
import { RentalManager } from './rental-manager';

export const dynamic = 'force-dynamic';

export default async function DomainRentalsPage() {
  const context = await dashboardApiContext();
  if (!context.token) redirect('/login?next=%2Faccount%2Fdomains');
  const result = await getJson('/domain-rentals', null, context);
  if (result.status === 401) redirect('/login?next=%2Faccount%2Fdomains');
  return <ConsoleShell active="overview" projectValue="도메인 대여" eyebrow="내 계정">
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <header className="space-y-2"><h1 className="text-2xl font-semibold">도메인 대여</h1>
        <p className="text-sm text-muted-foreground">서버나 프로젝트 없이 나만의 주소를 만들고, 원하는 사이트로 연결하세요.</p></header>
      {result.ok ? <RentalManager initial={result.body} /> : <div role="alert" className="rounded-md border p-4"><p>{result.error || '주소 목록을 불러오지 못했습니다.'}</p><a href="/account/domains" className="underline">다시 불러오기</a></div>}
    </div>
  </ConsoleShell>;
}
