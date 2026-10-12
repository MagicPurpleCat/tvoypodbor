import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { api, limitEvents, type Me } from './api';
import { NavContext, TABS, routeFromStart, type Nav, type Route } from './nav';
import { startParam, tg } from './tg';
import { B } from './copy';
import { Header, TabBar } from './components/ui';
import { Search } from './screens/Search';
import { Vacancy } from './screens/Vacancy';
import { CoverLetter } from './screens/CoverLetter';
import { Favorites } from './screens/Favorites';
import { History, Profile } from './screens/Profile';
import { Resume } from './screens/Resume';
import { Subscription } from './screens/Subscription';
import { Support } from './screens/Support';

export function App() {
  const [stack, setStack] = useState<Route[]>(() => routeFromStart(startParam()));
  const [me, setMe] = useState<Me | null>(null);
  const route = stack[stack.length - 1]!;

  const refreshMe = useCallback(() => { api.me().then(setMe).catch(() => {}); }, []);
  useEffect(refreshMe, []);

  const nav: Nav = useMemo(() => ({
    route,
    me,
    refreshMe,
    push: (r) => setStack((s) => [...s, r]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    tab: (name) => setStack([{ name } as Route]),
  }), [route, me, refreshMe]);

  // новый экран — сверху. Layout-эффект срабатывает раньше обычных, поэтому Search успевает восстановить свой скролл.
  useLayoutEffect(() => { window.scrollTo(0, 0); }, [route]);

  // нативная кнопка «Назад» Telegram
  useEffect(() => {
    if (!tg) return;
    if (stack.length > 1) tg.BackButton.show(); else tg.BackButton.hide();
    tg.BackButton.onClick(nav.back);
    return () => tg!.BackButton.offClick(nav.back);
  }, [stack.length, nav.back]);

  // 402 LIMIT_EXCEEDED из любого запроса → экран лимита с таймером
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { resetAt: string; limit: number };
      refreshMe();
      setStack((s) => (s[s.length - 1]?.name === 'subscription' ? s : [...s, { name: 'subscription', limit: d }]));
    };
    limitEvents.addEventListener('limit', h);
    return () => limitEvents.removeEventListener('limit', h);
  }, []);

  const isTab = (TABS as readonly string[]).includes(route.name) && stack.length === 1;

  return (
    <NavContext.Provider value={nav}>
      <div className="app">
        <Header />
        {/* вне Telegram нет нативной BackButton */}
        {!tg && stack.length > 1 && (
          <button className="btn btn-ghost sm" style={{ marginBottom: 12 }} onClick={nav.back}>← {B.back}</button>
        )}
        <Screen route={route} />
      </div>
      {isTab && <TabBar />}
    </NavContext.Provider>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'search': return <Search />;
    case 'vacancy': return <Vacancy key={route.id} id={route.id} />;
    case 'letter': return <CoverLetter vacancyId={route.vacancyId} />;
    case 'favorites': return <Favorites />;
    case 'profile': return <Profile />;
    case 'history': return <History />;
    case 'resume': return <Resume />;
    case 'subscription': return <Subscription limit={route.limit} paymentId={route.paymentId} />;
    case 'support': return <Support />;
  }
}
