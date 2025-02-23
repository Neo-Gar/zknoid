import {
  RuntimeModule,
  runtimeModule,
  state,
  runtimeMethod,
} from '@proto-kit/module';
import type { Option } from '@proto-kit/protocol';
import { Balances, UInt64 as ProtoUInt64 } from '@proto-kit/library';
import { State, StateMap, assert } from '@proto-kit/protocol';
import {
  PublicKey,
  Struct,
  UInt64,
  Provable,
  Bool,
  UInt32,
  Poseidon,
  Field,
  Int64,
} from 'o1js';
import { inject } from 'tsyringe';
import { ZNAKE_TOKEN_ID } from '../constants';

interface MatchMakerConfig {}

export const DEFAULT_GAME_COST = ProtoUInt64.from(10 ** 9);

export const PENDING_BLOCKS_NUM_CONST = 20;

const BLOCK_PRODUCTION_SECONDS = 5;
export const MOVE_TIMEOUT_IN_BLOCKS = 60 / BLOCK_PRODUCTION_SECONDS;

const PENDING_BLOCKS_NUM = UInt64.from(PENDING_BLOCKS_NUM_CONST);

export class RoundIdxUser extends Struct({
  roundId: UInt64,
  userAddress: PublicKey,
}) {}

export class RoundIdxIndex extends Struct({
  roundId: UInt64,
  index: UInt64,
}) {}

export class AddressxAddress extends Struct({
  user1: PublicKey,
  user2: PublicKey,
}) {}

export class QueueListItem extends Struct({
  userAddress: PublicKey,
  registrationTimestamp: UInt64,
}) {}

// abstract class

@runtimeModule()
export class MatchMaker extends RuntimeModule<MatchMakerConfig> {
  // Session => user
  @state() public sessions = StateMap.from<PublicKey, PublicKey>(
    PublicKey,
    PublicKey,
  );
  // mapping(roundId => mapping(registered user address => bool))
  @state() public queueRegisteredRoundUsers = StateMap.from<RoundIdxUser, Bool>(
    RoundIdxUser,
    Bool,
  );
  // mapping(roundId => SessionKey[])
  @state() public queueRoundUsersList = StateMap.from<
    RoundIdxIndex,
    QueueListItem
  >(RoundIdxIndex, QueueListItem);
  @state() public queueLength = StateMap.from<UInt64, UInt64>(UInt64, UInt64);

  @state() public activeGameId = StateMap.from<PublicKey, UInt64>(
    PublicKey,
    UInt64,
  );

  @state() public pendingBalances = StateMap.from<PublicKey, ProtoUInt64>(
    PublicKey,
    ProtoUInt64,
  );

  // Game ids start from 1
  // abstract games: StateMap<UInt64, any>;
  @state() public games = StateMap.from<UInt64, any>(UInt64, UInt64);

  @state() public gamesNum = State.from<UInt64>(UInt64);

  @state() public gameFund = StateMap.from<UInt64, ProtoUInt64>(
    UInt64,
    ProtoUInt64,
  );

  @state() public gameFinished = StateMap.from<UInt64, Bool>(UInt64, Bool);

  public constructor(@inject('Balances') private balances: Balances) {
    super();
  }

  /**
   * Initializes game when opponent is found
   *
   * @param opponentReady - Is opponent found. If not ready, function call should process this case without initialization
   * @param opponent - Opponent if opponent is ready
   * @returns Id of the new game. Will be set for player and opponent
   */
  public initGame(
    opponentReady: Bool,
    opponent: Option<QueueListItem>,
  ): UInt64 {
    this.pendingBalances.set(
      Provable.if(
        opponentReady,
        this.transaction.sender.value,
        PublicKey.empty(),
      ),
      ProtoUInt64.from(0),
    );

    this.pendingBalances.set(
      Provable.if(opponentReady, opponent.value.userAddress, PublicKey.empty()),
      ProtoUInt64.from(0),
    );

    return UInt64.from(0);
  }

  /**
   * Registers user in session queue
   *
   * @param sessionKey - Key of user background session
   * @param timestamp - Current user timestamp from front-end
   */
  @runtimeMethod()
  public register(sessionKey: PublicKey, timestamp: UInt64): void {
    // If player in game – revert
    assert(
      this.activeGameId
        .get(this.transaction.sender.value)
        .orElse(UInt64.from(0))
        .equals(UInt64.from(0)),
      'Player already in game',
    );

    // Registering player session key
    this.sessions.set(sessionKey, this.transaction.sender.value);
    const roundId = this.network.block.height.div(PENDING_BLOCKS_NUM);

    // User can't re-register in round queue if already registered
    assert(
      this.queueRegisteredRoundUsers
        .get(
          new RoundIdxUser({
            roundId,
            userAddress: this.transaction.sender.value,
          }),
        )
        .isSome.not(),
      'User already in queue',
    );

    const queueLength = this.queueLength.get(roundId).orElse(UInt64.from(0));

    const opponentReady = queueLength.greaterThan(UInt64.from(0));
    const opponent = this.queueRoundUsersList.get(
      new RoundIdxIndex({
        roundId,
        index: queueLength.sub(
          Provable.if(opponentReady, UInt64.from(1), UInt64.from(0)),
        ),
      }),
    );

    const gameId = this.initGame(opponentReady, opponent);

    // Assigning new game to player if opponent found
    this.activeGameId.set(
      this.transaction.sender.value,
      Provable.if(opponentReady, gameId, UInt64.from(0)),
    );

    // Setting that opponent is in game if opponent found
    this.activeGameId.set(
      Provable.if(opponentReady, opponent.value.userAddress, PublicKey.empty()),
      gameId,
    );

    // If opponent not found – adding current user to the list
    this.queueRoundUsersList.set(
      new RoundIdxIndex({ roundId, index: queueLength }),
      new QueueListItem({
        userAddress: Provable.if(
          opponentReady,
          PublicKey.empty(),
          this.transaction.sender.value,
        ),
        registrationTimestamp: timestamp,
      }),
    );

    // If opponent not found – registering current user in the list
    this.queueRegisteredRoundUsers.set(
      new RoundIdxUser({
        roundId,
        userAddress: Provable.if(
          opponentReady,
          PublicKey.empty(),
          this.transaction.sender.value,
        ),
      }),
      Bool(true),
    );

    // If opponent found – removing him from queue
    this.queueRegisteredRoundUsers.set(
      new RoundIdxUser({
        roundId,
        userAddress: Provable.if(
          opponentReady,
          opponent.value.userAddress,
          PublicKey.empty(),
        ),
      }),
      Bool(false),
    );

    // If opponent not found – incrementing queue length. If found – removing opponent by length decreasing
    this.queueLength.set(
      roundId,
      Provable.if(
        opponentReady,
        queueLength.sub(
          Provable.if(opponentReady, UInt64.from(1), UInt64.from(0)),
        ),
        queueLength.add(1),
      ),
    );

    const fee = this.getParticipationPrice();

    const pendingBalance = ProtoUInt64.from(
      this.pendingBalances.get(this.transaction.sender.value).value,
    );

    const amountToTransfer = Provable.if<ProtoUInt64>(
      pendingBalance.greaterThan(fee),
      ProtoUInt64,
      ProtoUInt64.from(0),
      fee,
    );

    this.balances.transfer(
      ZNAKE_TOKEN_ID,
      this.transaction.sender.value,
      PublicKey.empty(),
      amountToTransfer,
    );
    this.pendingBalances.set(
      this.transaction.sender.value,
      pendingBalance.add(amountToTransfer),
    );
  }

  /**
   * Registers user in session queue
   *
   * @param sessionKey - Key of user background session
   * @param timestamp - Current user timestamp from front-end
   */
  @runtimeMethod()
  public collectPendingBalance(): void {
    const sender = this.sessions.get(this.transaction.sender.value).value;

    const pendingBalance = ProtoUInt64.from(
      this.pendingBalances.get(sender).value,
    );

    this.balances.mint(ZNAKE_TOKEN_ID, sender, pendingBalance);
    this.pendingBalances.set(sender, ProtoUInt64.from(0));
  }

  @runtimeMethod()
  public proveOpponentTimeout(gameId: UInt64): void {
    const sessionSender = this.sessions.get(this.transaction.sender.value);
    const sender = Provable.if(
      sessionSender.isSome,
      sessionSender.value,
      this.transaction.sender.value,
    );
    const game = this.games.get(gameId);
    const nextUser = Provable.if(
      game.value.currentMoveUser.equals(game.value.player1),
      game.value.player2,
      game.value.player1,
    );
    assert(game.isSome, 'Invalid game id');
    assert(nextUser.equals(sender), `Not your move`);
    assert(game.value.winner.equals(PublicKey.empty()), `Game finished`);

    const isTimeout = this.network.block.height
      .sub(game.value.lastMoveBlockHeight)
      .greaterThan(UInt64.from(MOVE_TIMEOUT_IN_BLOCKS));

    assert(isTimeout, 'Timeout not reached');

    game.value.winner = sender;
    game.value.lastMoveBlockHeight = this.network.block.height;
    this.games.set(gameId, game.value);

    // Removing active game for players if game ended
    this.activeGameId.set(game.value.player1, UInt64.from(0));
    this.activeGameId.set(game.value.player2, UInt64.from(0));
  }

  protected getParticipationPrice() {
    return DEFAULT_GAME_COST;
  }

  protected getFunds(gameId: UInt64, player1: PublicKey, player2: PublicKey, player1Share: ProtoUInt64, player2Share: ProtoUInt64) {
    assert(this.gameFinished.get(gameId).value.not());

    this.gameFinished.set(gameId, Bool(true));

    this.balances.mint(ZNAKE_TOKEN_ID, player1, ProtoUInt64.from(this.gameFund.get(gameId).value).mul(player1Share).div(player1Share.add(player2Share)));
    this.balances.mint(ZNAKE_TOKEN_ID, player2, ProtoUInt64.from(this.gameFund.get(gameId).value).mul(player2Share).div(player1Share.add(player2Share)));
  }
}
