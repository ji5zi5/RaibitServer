'use client';

import { useRef, useState, useTransition, type FormEvent } from 'react';
import { ArrowRightIcon, ArrowUpRightIcon, CopyIcon, GlobeIcon, LinkIcon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { mutateRental, refreshRentals } from './actions';

type Rental = { id: string; name: string; hostname: string; url: string; targetUrl: string; enabled: boolean; version: number; quotaSuspended: boolean };
type RentalList = { baseDomain: string; limit: number; used: number; remaining: number; accountType: string; nameMaxLength: number; targetMaxLength: number; rentals: Rental[] };
const staleCodes = new Set(['DOMAIN_RENTAL_VERSION_CONFLICT', 'DOMAIN_RENTAL_NOT_FOUND', 'DOMAIN_RENTAL_QUOTA_EXCEEDED']);

export function RentalManager({ initial }: { initial: RentalList }) {
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState<Rental | null>(null);
  const [deleting, setDeleting] = useState<Rental | null>(null);
  const [name, setName] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const activeCount = data.rentals.filter((rental) => rental.enabled && !rental.quotaSuspended).length;
  const cannotWrite = pending || needsRefresh;
  const reset = () => { setEditing(null); setName(''); setTargetUrl(''); };
  const unavailable = (text: string) => { setFailed(true); setNeedsRefresh(true); setMessage(text); };

  const reload = () => {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      try {
        const next = await refreshRentals();
        if (!next.ok || !next.body) { unavailable('목록을 불러오지 못했습니다. 다시 시도해 주세요.'); return; }
        setData(next.body); reset(); setDeleting(null); setNeedsRefresh(false); setFailed(false); setMessage('목록을 새로 불러왔습니다.');
      } catch { unavailable('연결이 끊겼습니다. 목록 새로고침으로 저장 여부를 확인해 주세요.'); }
      finally { busy.current = false; }
    });
  };

  const mutate = (operation: 'create' | 'update' | 'delete', id: string | null, input: unknown, clear = false) => {
    if (busy.current || needsRefresh) return;
    busy.current = true;
    setMessage(''); setFailed(false);
    startTransition(async () => {
      try {
        const result = await mutateRental(operation, id, input);
        if (!result.ok) {
          setFailed(true); setMessage(result.message);
          if (staleCodes.has(result.code || '')) setNeedsRefresh(true);
          return;
        }
        if (clear) reset();
        setDeleting(null);
        const next = await refreshRentals();
        if (next.ok && next.body) { setData(next.body); setMessage(result.message); }
        else unavailable('변경은 저장했지만 목록을 갱신하지 못했습니다. 목록 새로고침으로 확인해 주세요.');
      } catch { unavailable('연결이 끊겼습니다. 다시 요청하기 전에 목록 새로고침으로 저장 여부를 확인해 주세요.'); }
      finally { busy.current = false; }
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutate(editing ? 'update' : 'create', editing?.id || null,
      { name: name.trim(), targetUrl: targetUrl.trim(), ...(editing ? { expectedVersion: editing.version } : {}) }, true);
  };
  const edit = (rental: Rental) => {
    setEditing(rental); setName(rental.name); setTargetUrl(rental.targetUrl); setMessage('');
    nameInput.current?.focus();
  };
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setFailed(false); setMessage('주소를 복사했습니다.'); }
    catch { setFailed(true); setMessage('자동 복사를 사용할 수 없습니다. 표시된 주소를 선택하여 복사해 주세요.'); }
  };

  return <Dialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open && !pending) setDeleting(null); }}>
    <div className="flex min-w-0 flex-col gap-6" data-domain-rentals>
      <section className="grid min-w-0 gap-3 sm:grid-cols-3" aria-label="대여 현황">
        <Card size="sm"><CardHeader><CardDescription>대여한 주소</CardDescription><CardTitle className="text-2xl tabular-nums">{data.used} <span className="text-sm font-normal text-muted-foreground">/ {data.limit}개</span></CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{data.accountType === 'CLUB_MEMBER' ? '동아리원' : '일반 회원'} · 계정 전체 기준</p></CardContent></Card>
        <Card size="sm"><CardHeader><CardDescription>현재 연결 중</CardDescription><CardTitle className="text-2xl tabular-nums">{activeCount}<span className="ml-1 text-sm font-normal text-muted-foreground">개</span></CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">활성 상태이며 한도 내인 주소</p></CardContent></Card>
        <Card size="sm"><CardHeader><CardDescription>추가로 대여 가능</CardDescription><CardTitle className="text-2xl tabular-nums text-primary">{data.remaining}<span className="ml-1 text-sm font-normal text-muted-foreground">개</span></CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">중지한 주소도 대여 개수에 포함</p></CardContent></Card>
      </section>
      {data.used > data.limit && <p role="status" className="rounded-md border border-border bg-muted/50 p-4 text-sm leading-6">회원 구분이 변경되어 한도를 초과했습니다. 초과 주소는 보관되지만 연결되지 않습니다. 기존 주소를 삭제하면 다음 주소가 다시 연결됩니다.</p>}

      <Card id="rental-editor">
        <CardHeader className="border-b border-border"><CardTitle><h2>{editing ? '주소 수정' : '새 주소 만들기'}</h2></CardTitle><CardDescription>원하는 이름과 연결할 사이트 주소를 입력하세요.</CardDescription></CardHeader>
        <form onSubmit={submit} aria-label={editing ? '주소 수정' : '새 주소 만들기'} className="flex min-w-0 flex-col gap-4">
          <CardContent className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <FieldGroup>
              <Field><FieldLabel htmlFor="rental-name">주소 이름</FieldLabel>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                  <Input ref={nameInput} id="rental-name" name="name" className="min-w-0 font-mono" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} required minLength={1} maxLength={data.nameMaxLength} pattern={'[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?'} autoCapitalize="none" autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="my-project" disabled={cannotWrite} aria-describedby="rental-name-help" />
                  <span className="break-all text-sm text-muted-foreground sm:shrink-0">.{data.baseDomain}</span>
                </div>
                <FieldDescription id="rental-name-help">영문·숫자·하이픈 1~{data.nameMaxLength}자 · 처음과 끝은 영문 또는 숫자 <span className="whitespace-nowrap tabular-nums">({name.length}/{data.nameMaxLength})</span></FieldDescription>
              </Field>
              <Field><FieldLabel htmlFor="rental-target">연결할 주소</FieldLabel><Input id="rental-target" name="targetUrl" type="url" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} maxLength={data.targetMaxLength} required placeholder="https://example.com/page?v=1" disabled={cannotWrite} aria-describedby="rental-target-help" /><FieldDescription id="rental-target-help">http:// 또는 https://로 시작하는 공개 주소를 입력하세요.</FieldDescription></Field>
            </FieldGroup>
            <aside className="min-w-0 space-y-4 rounded-md border border-border bg-muted/40 p-4" aria-label="연결 미리보기">
              <p className="flex items-center gap-2 text-sm font-medium"><LinkIcon className="size-4" aria-hidden="true" />연결 미리보기</p>
              <div className="min-w-0 space-y-2 text-sm"><p className="break-all font-mono text-primary">https://{name || 'my-project'}.{data.baseDomain}</p><ArrowRightIcon className="size-4 text-muted-foreground" aria-hidden="true" /><p className="break-all text-muted-foreground">{targetUrl || '연결할 사이트 주소'}</p></div>
              <p className="text-xs leading-5 text-muted-foreground">접속하면 목적지로 이동하고 주소창도 바뀝니다. 입력한 목적지의 경로·쿼리·#항목을 그대로 사용합니다. 이름의 사용 가능 여부는 저장할 때 확인합니다.</p>
            </aside>
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-muted-foreground">{!editing && data.remaining === 0 ? '한도를 모두 사용했습니다. 기존 주소를 삭제하면 새로 대여할 수 있습니다.' : '서버·프로젝트 생성 없이 주소만 대여합니다.'}</p>
            <div className="flex shrink-0 flex-wrap gap-2">{editing && <Button type="button" variant="outline" onClick={reset} disabled={pending}>수정 취소</Button>}<Button className="max-sm:flex-1" type="submit" disabled={cannotWrite || (!editing && data.remaining === 0)}>{pending ? <Spinner aria-hidden="true" /> : editing ? <PencilIcon aria-hidden="true" /> : <PlusIcon aria-hidden="true" />}{pending ? '처리 중…' : editing ? '변경 저장' : '주소 대여'}</Button></div>
          </CardFooter>
        </form>
      </Card>

      <div role={failed ? 'alert' : 'status'} aria-live={failed ? 'assertive' : 'polite'} aria-atomic="true" className={message && !deleting ? `rounded-md border p-3 text-sm ${failed ? 'border-destructive/30 text-destructive' : 'border-border text-foreground'}` : 'sr-only'}>{!deleting && message}</div>
      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="rental-list-title" aria-busy={pending}>
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="rental-list-title" className="flex items-center gap-2 text-base font-medium">내 주소 <Badge variant="outline">{data.used}</Badge></h2><Button type="button" variant="outline" size="sm" disabled={pending} onClick={reload}><RefreshCwIcon aria-hidden="true" />목록 새로고침</Button></div>
        {needsRefresh && <p className="text-sm text-muted-foreground">최신 목록을 확인한 뒤 다시 관리할 수 있습니다. 목록 새로고침 시 입력 중인 내용은 초기화됩니다.</p>}
        {data.rentals.length === 0 ? <Empty className="border border-dashed border-border bg-card py-10"><EmptyHeader><EmptyMedia variant="icon"><GlobeIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>아직 대여한 주소가 없습니다</EmptyTitle><EmptyDescription>위에서 첫 주소를 만들고 기억하기 쉬운 링크를 공유해 보세요.</EmptyDescription></EmptyHeader></Empty> : data.rentals.map((rental) => <article key={rental.id} data-rental-hostname={rental.hostname} aria-label={rental.hostname} className="min-w-0 rounded-lg border border-border bg-card p-4">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50"><GlobeIcon className="size-4 text-muted-foreground" aria-hidden="true" /></span><div className="min-w-0 space-y-1"><a className="break-all font-mono text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={rental.url} target="_blank" rel="noopener noreferrer">{rental.hostname}<ArrowUpRightIcon className="ml-1 inline size-3.5" aria-hidden="true" /><span className="sr-only"> (새 탭)</span></a><p className="break-all text-xs leading-5 text-muted-foreground">{rental.targetUrl}</p></div></div>
            <Badge variant={rental.quotaSuspended ? 'destructive' : rental.enabled ? 'secondary' : 'outline'} className={rental.enabled && !rental.quotaSuspended ? 'bg-primary-soft text-primary' : undefined}>{rental.quotaSuspended ? '한도 초과 · 중지' : rental.enabled ? '연결 중' : '일시 중지'}</Badge>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3 sm:justify-end"><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void copy(rental.url)}><CopyIcon aria-hidden="true" />주소 복사</Button><Button type="button" variant="outline" size="sm" disabled={cannotWrite} onClick={() => edit(rental)}><PencilIcon aria-hidden="true" />수정</Button><Button type="button" variant="outline" size="sm" disabled={cannotWrite || rental.quotaSuspended} onClick={() => mutate('update', rental.id, { expectedVersion: rental.version, enabled: !rental.enabled }, editing?.id === rental.id)}>{rental.enabled ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}{rental.enabled ? '일시 중지' : '다시 연결'}</Button><DialogTrigger onClick={() => { setMessage(''); setFailed(false); setDeleting(rental); }} render={<Button type="button" variant="destructive" size="sm" disabled={cannotWrite} />}><Trash2Icon aria-hidden="true" />삭제</DialogTrigger></div>
        </article>)}
      </section>
      <p className="text-xs leading-5 text-muted-foreground">운영용 이름과 이미 사용 중인 이름은 대여할 수 없습니다. 삭제한 이름은 다른 사람이 사용할 수 있습니다.</p>
    </div>
    <DialogContent showCloseButton={!pending}>
      <DialogHeader><DialogTitle>주소를 삭제할까요?</DialogTitle><DialogDescription><span className="break-all font-medium text-foreground">{deleting?.hostname}</span>의 연결이 중단됩니다. 삭제한 이름은 다른 사람이 대여할 수 있으며 되돌릴 수 없습니다.</DialogDescription></DialogHeader>
      {failed && message && <p role="alert" className="text-sm text-destructive">{message}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => setDeleting(null)}>취소</Button><Button type="button" variant="destructive" disabled={cannotWrite || !deleting} onClick={() => { if (deleting) mutate('delete', deleting.id, { expectedVersion: deleting.version }, editing?.id === deleting.id); }}>{pending && <Spinner aria-hidden="true" />}{pending ? '삭제 중…' : '삭제 확인'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
