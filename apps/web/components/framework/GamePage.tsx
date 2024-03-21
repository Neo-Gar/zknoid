'use client';

import { RuntimeModulesRecord } from '@proto-kit/module';
import { ClientAppChain } from '@proto-kit/sdk';
import { ReactNode, useContext, useEffect, useState } from 'react';

import AppChainClientContext from '@/lib/contexts/AppChainClientContext';
import { ZkNoidGameConfig } from '@/lib/createConfig';
import { useObserveMinaBalance } from '@/lib/stores/minaBalances';
import { usePollMinaBlockHeight } from '@/lib/stores/minaChain';
import { useNetworkStore } from '@/lib/stores/network';
import { useObserveProtokitBalance } from '@/lib/stores/protokitBalances';
import { usePollProtokitBlockHeight } from '@/lib/stores/protokitChain';

import DesktopNavbar from '../ui/games-store/DesktopNavbar';
import { Footer } from '@/components/Footer';
import Image from 'next/image';

export default function GamePage<RuntimeModules extends RuntimeModulesRecord>({
  children,
  gameConfig,
  image,
  switchWidget,
}: {
  children: ReactNode;
  gameConfig: ZkNoidGameConfig<RuntimeModules>;
  image: string;
  switchWidget: ReactNode;
}) {
  const client = useContext(AppChainClientContext) as ClientAppChain<any>;

  usePollMinaBlockHeight();
  usePollProtokitBlockHeight();
  useObserveMinaBalance();
  const networkStore = useNetworkStore();

  useEffect(() => {
    console.log('Starting client');

    client.start().then(() => networkStore.onProtokitClientStarted());
  }, []);

  // Order is important
  useObserveProtokitBalance({ client });

  return (
    <>
      <DesktopNavbar autoconnect={true} />
      <div className={'flex flex-col px-5'}>
        <div className={'mb-12 w-full rounded-2xl border-2 border-left-accent'}>
          <Image
            src={image}
            alt={'Game'}
            width={1500}
            height={30}
            className={'w-full object-contain object-center'}
          />
        </div>
        {switchWidget}
        <div
          className={
            'relative flex w-full flex-col gap-20 rounded-2xl border-2 border-left-accent p-10 pb-[100px]'
          }
        >
          <div
            className={
              'absolute left-0 top-0 -z-10 h-[200px] w-full bg-bg-dark'
            }
          />
          {children}
        </div>
      </div>
      <Footer />
    </>
  );
}
