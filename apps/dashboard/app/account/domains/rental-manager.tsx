'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { mutateRental, refreshRentals } from './actions';

type Rental = { id: string; name: string; hostname: string; url: string; targetUrl: string; enabled: boolean; version: number; quotaSuspended: boolean };
type RentalList = { baseDomain: string; limit: number; used: number; remaining: number; accountType: string; nameMaxLength: number; targetMaxLength: number; rentals: Rental[] };

export function RentalManager({ initial }: { initial: RentalList }) {
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState<Rental | null>(null);
  const [name, setName] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const reset = () => { setEditing(null); setName(''); setTargetUrl(''); };
  const mutate = (operation: 'create' | 'update' | 'delete', id: string | null, input: unknown, clear = false) => {
    setMessage('');
    startTransition(async () => {
      try {
        const result = await mutateRental(operation, id, input);
        setFailed(!result.ok); setMessage(result.message);
        if (result.ok) {
          if (clear) reset();
          const next = await refreshRentals();
          if (next.ok && next.body) setData(next.body);
          else { setFailed(true); setMessage('변경은 저장했지만 목록을 갱신하지 못했습니다. 새로고침해 주세요.'); }
        }
      } catch { setFailed(true); setMessage('연결이 끊겼습니다. 새로고침으로 저장 여부를 확인해 주세요.'); }
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutate(editing ? 'update' : 'create', editing?.id || null,
      { name, targetUrl, ...(editing ? { expectedVersion: editing.version } : {}) }, true);
  };
  const edit = (rental: Rental) => { setEditing(rental); setName(rental.name); setTargetUrl(rental.targetUrl); setMessage(''); document.getElementById('rental-name')?.focus(); };
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setFailed(false); setMessage('주소를 복사했습니다.'); }
    catch { setFailed(true); setMessage('자동 복사를 사용할 수 없습니다. 표시된 주소를 길게 눌러 복사해 주세요.'); }
  };

  return <div className="space-y-6">
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4" aria-label="대여 한도">
      <div><p className="font-medium">{data.accountType === 'CLUB_MEMBER' ? '동아리원' : '일반 회원'}</p><p className="text-sm text-muted-foreground">계정 전체 기준 · 중지한 주소도 개수에 포함됩니다.</p></div>
      <p className="text-lg font-semibold">{data.used} / {data.limit}개</p>
    </section>
    {data.used > data.limit && <p role="status" className="rounded-md border p-3 text-sm">회원 구분이 변경되어 한도를 초과했습니다. 초과 주소는 보관되지만 연결되지 않습니다. 기존 주소를 삭제하면 다음 주소가 다시 연결됩니다.</p>}
    <form onSubmit={submit} className="space-y-4 rounded-lg border bg-card p-4 md:p-5">
      <h2 className="font-semibold">{editing ? '주소 수정' : '새 주소 만들기'}</h2>
      <div className="space-y-2"><label htmlFor="rental-name" className="text-sm font-medium">이름</label>
        <div className="flex min-w-0 items-center gap-2"><Input id="rental-name" className="min-w-0 font-mono" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} required minLength={1} maxLength={data.nameMaxLength} pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="my-project" disabled={pending} aria-describedby="rental-name-help" /><span className="shrink-0 text-sm">.{data.baseDomain}</span></div>
        <p id="rental-name-help" className="text-xs text-muted-foreground">영문·숫자·하이픈, 최대 {data.nameMaxLength}자 · {name.length}/{data.nameMaxLength}</p>
      </div>
      <div className="space-y-2"><label htmlFor="rental-target" className="text-sm font-medium">연결할 주소</label><Input id="rental-target" type="url" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} maxLength={data.targetMaxLength} required placeholder="https://example.com/page?v=1" disabled={pending} aria-describedby="rental-target-help" /><p id="rental-target-help" className="text-xs text-muted-foreground">접속하면 이 주소로 이동하며 주소창도 바뀝니다. 입력한 경로·쿼리·#항목을 그대로 사용합니다.</p></div>
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending || (!editing && data.remaining === 0)}>{pending ? '처리 중…' : editing ? '변경 저장' : '주소 대여'}</Button>{editing && <Button type="button" variant="outline" onClick={reset} disabled={pending}>수정 취소</Button>}</div>
      {!editing && data.remaining === 0 && <p className="text-sm text-muted-foreground">한도를 모두 사용했습니다. 아래에서 기존 주소를 관리하거나 삭제해 주세요.</p>}
    </form>
    <p role={failed ? 'alert' : 'status'} aria-live="polite" className={failed ? 'text-sm text-destructive' : 'text-sm'}>{message}</p>
    <section className="space-y-3" aria-label="내 대여 주소"><h2 className="font-semibold">내 주소</h2>
      {data.rentals.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">아직 대여한 주소가 없습니다.</p>}
      {data.rentals.map((rental) => <article key={rental.id} className="min-w-0 space-y-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2"><a className="break-all font-mono text-sm font-medium underline underline-offset-4" href={rental.url} target="_blank" rel="noopener noreferrer">{rental.hostname}</a><span className="text-xs text-muted-foreground">{rental.quotaSuspended ? '한도 초과 · 중지' : rental.enabled ? '활성' : '일시 중지'}</span></div>
        <p className="break-all text-sm text-muted-foreground">→ {rental.targetUrl}</p>
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={() => void copy(rental.url)}>주소 복사</Button><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => edit(rental)}>수정</Button><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => mutate('update', rental.id, { expectedVersion: rental.version, enabled: !rental.enabled }, editing?.id === rental.id)}>{rental.enabled ? '일시 중지' : '다시 연결'}</Button><Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => { if (window.confirm(`${rental.hostname} 주소를 삭제할까요? 연결이 중단되고 다른 사람이 이 이름을 사용할 수 있습니다.`)) mutate('delete', rental.id, { expectedVersion: rental.version }, editing?.id === rental.id); }}>삭제</Button></div>
      </article>)}
    </section>
  </div>;
}
