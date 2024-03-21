'use client';

import { useMemo } from 'react';

import { zkNoidConfig } from '@/games/config';
import AppChainClientContext from '@/lib/contexts/AppChainClientContext';
import NewArkanoidCompetitionPage from "@/games/arkanoid/components/NewArkanoidCompetitionPage";

export default function Page() {
  // const config = useMemo(
  //   () => zkNoidConfig.games.find((game) => game.id == gameId)!,
  //   []
  // );
  const client = useMemo(() => zkNoidConfig.getClient(), []);

  // const NewCompetitionPage = config.pageNewCompetition!;

  return (
    <AppChainClientContext.Provider value={client}>
      <NewArkanoidCompetitionPage />
    </AppChainClientContext.Provider>
  );
}
