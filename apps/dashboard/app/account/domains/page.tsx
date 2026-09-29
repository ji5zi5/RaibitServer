import { redirect } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConsoleShell } from '../../../components/console-ui';
import { dashboardApiContext, getJson } from '../../../lib/api';
import { RentalManager } from './rental-manager';

export const dynamic = 'force-dynamic';

export default async function DomainRentalsPage() {
  const context = await dashboardApiContext();
  if (!context.token) redirect('/login?next=%2Faccount%2Fdomains');
  const result = await getJson('/domain-rentals', null, context);
  if (result.status === 401) redirect('/login?next=%2Faccount%2Fdomains');
  return <ConsoleShell active="domains" projectLabel="현재 메뉴" projectValue="도메인 대여" eyebrow="내 계정">
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:px-8 md:py-10">
      <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1"><p className="text-sm font-medium text-primary">나만의 주소</p><h1 className="text-3xl font-medium tracking-tight text-foreground text-balance">도메인 대여</h1><p className="max-w-2xl text-sm leading-6 text-muted-foreground text-pretty">서버나 프로젝트 없이 기억하기 쉬운 주소를 만들고, 원하는 사이트로 연결하세요.</p></div>
        <Badge variant="outline">동아리원 5개 · 일반 회원 2개</Badge>
      </header>
      {result.ok && result.body ? <RentalManager initial={result.body} /> : <Card role="alert"><CardHeader><CardTitle>주소 목록을 불러오지 못했습니다</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-sm text-muted-foreground">{result.error || '잠시 후 다시 시도해 주세요.'}</p><a href="/account/domains" className={buttonVariants({ variant: 'outline', size: 'sm' })}>다시 불러오기</a></CardContent></Card>}
    </section>
  </ConsoleShell>;
}
