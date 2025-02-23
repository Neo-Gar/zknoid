import { state, runtimeMethod, runtimeModule } from '@proto-kit/module';
import type { Option } from '@proto-kit/protocol';
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
import { DEFAULT_GAME_COST, MatchMaker } from '../engine/MatchMaker';
import type { QueueListItem } from '../engine/MatchMaker';
import { UInt64 as ProtoUInt64 } from '@proto-kit/library';

const RANDZU_FIELD_SIZE = 15;
const CELLS_LINE_TO_WIN = 5;

const BLOCK_PRODUCTION_SECONDS = 5;
const MOVE_TIMEOUT_IN_BLOCKS = 60 / BLOCK_PRODUCTION_SECONDS;

export class WinWitness extends Struct({
  x: UInt32,
  y: UInt32,
  directionX: Int64,
  directionY: Int64,
}) {
  assertCorrect() {
    assert(
      this.directionX
        .equals(-1)
        .or(this.directionX.equals(0))
        .or(this.directionX.equals(1)),
      'Invalid direction X',
    );
    assert(
      this.directionY
        .equals(-1)
        .or(this.directionY.equals(0))
        .or(this.directionY.equals(1)),
      'Invalid direction Y',
    );
  }
}

export class RandzuField extends Struct({
  value: Provable.Array(
    Provable.Array(UInt32, RANDZU_FIELD_SIZE),
    RANDZU_FIELD_SIZE,
  ),
}) {
  static from(value: number[][]) {
    return new RandzuField({
      value: value.map((row) => row.map((x) => UInt32.from(x))),
    });
  }

  checkWin(currentUserId: number): WinWitness | undefined {
    const directions = [
      [0, 1],
      [1, 0],
      [1, 1],
      [-1, 1],
    ];

    for (const direction of directions) {
      for (let i = 0; i <= RANDZU_FIELD_SIZE; i++) {
        for (let j = 0; j <= RANDZU_FIELD_SIZE; j++) {
          let combo = 0;

          for (let k = 0; k < CELLS_LINE_TO_WIN; k++) {
            if (
              i + direction[0] * k >= RANDZU_FIELD_SIZE - 1 ||
              j + direction[1] * k >= RANDZU_FIELD_SIZE - 1 ||
              i + direction[0] * k < 0 ||
              j + direction[1] * k < 0
            )
              break;

            if (
              this.value[i + direction[0] * k][j + direction[1] * k]
                .equals(UInt32.from(currentUserId))
                .toBoolean()
            )
              combo++;
          }

          if (combo === CELLS_LINE_TO_WIN) {
            return new WinWitness({
              x: UInt32.from(i),
              y: UInt32.from(j),
              directionX: Int64.from(direction[0]),
              directionY: Int64.from(direction[1]),
            });
          }
        }
      }
    }

    return undefined;
  }

  hash() {
    return Poseidon.hash(this.value.flat().map((x) => x.value));
  }
}

export class GameInfo extends Struct({
  player1: PublicKey,
  player2: PublicKey,
  currentMoveUser: PublicKey,
  lastMoveBlockHeight: UInt64,
  field: RandzuField,
  winner: PublicKey,
}) {}

@runtimeModule()
export class RandzuLogic extends MatchMaker {
  // Game ids start from 1
  @state() public games = StateMap.from<UInt64, GameInfo>(UInt64, GameInfo);

  @state() public gamesNum = State.from<UInt64>(UInt64);

  public override initGame(
    opponentReady: Bool,
    opponent: Option<QueueListItem>,
  ): UInt64 {
    const currentGameId = this.gamesNum
      .get()
      .orElse(UInt64.from(0))
      .add(UInt64.from(1));
    // Setting active game if opponent found
    this.games.set(
      Provable.if(opponentReady, currentGameId, UInt64.from(0)),
      new GameInfo({
        player1: this.transaction.sender.value,
        player2: opponent.value.userAddress,
        currentMoveUser: this.transaction.sender.value,
        lastMoveBlockHeight: this.network.block.height,
        field: RandzuField.from(
          Array(RANDZU_FIELD_SIZE).fill(Array(RANDZU_FIELD_SIZE).fill(0)),
        ),
        winner: PublicKey.empty(),
      }),
    );

    this.gamesNum.set(currentGameId);
    this.gameFund.set(currentGameId, this.getParticipationPrice().mul(2));

    super.initGame(opponentReady, opponent);

    return currentGameId;
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
    assert(game.isSome, 'Invalid game id');
    assert(game.value.currentMoveUser.equals(sender), `Not your move`);
    assert(game.value.winner.equals(PublicKey.empty()), `Game finished`);

    const isTimeout = this.network.block.height
      .sub(game.value.lastMoveBlockHeight)
      .greaterThan(UInt64.from(MOVE_TIMEOUT_IN_BLOCKS));

    assert(isTimeout, 'Timeout not reached');

    game.value.currentMoveUser = Provable.if(
      game.value.currentMoveUser.equals(game.value.player1),
      game.value.player2,
      game.value.player1,
    );
    game.value.lastMoveBlockHeight = this.network.block.height;
    this.games.set(gameId, game.value);
  }

  @runtimeMethod()
  public makeMove(
    gameId: UInt64,
    newField: RandzuField,
    winWitness: WinWitness,
  ): void {
    const sessionSender = this.sessions.get(this.transaction.sender.value);
    const sender = Provable.if(
      sessionSender.isSome,
      sessionSender.value,
      this.transaction.sender.value,
    );

    const game = this.games.get(gameId);
    assert(game.isSome, 'Invalid game id');
    assert(game.value.currentMoveUser.equals(sender), `Not your move`);
    assert(game.value.winner.equals(PublicKey.empty()), `Game finished`);

    winWitness.assertCorrect();

    const winProposed = Bool.and(
      winWitness.directionX.equals(UInt32.from(0)),
      winWitness.directionY.equals(UInt32.from(0)),
    ).not();

    const currentUserId = Provable.if(
      game.value.currentMoveUser.equals(game.value.player1),
      UInt32.from(1),
      UInt32.from(2),
    );

    const addedCellsNum = UInt64.from(0);
    for (let i = 0; i < RANDZU_FIELD_SIZE; i++) {
      for (let j = 0; j < RANDZU_FIELD_SIZE; j++) {
        const currentFieldCell = game.value.field.value[i][j];
        const nextFieldCell = newField.value[i][j];

        assert(
          Bool.or(
            currentFieldCell.equals(UInt32.from(0)),
            currentFieldCell.equals(nextFieldCell),
          ),
          `Modified filled cell at ${i}, ${j}`,
        );

        addedCellsNum.add(
          Provable.if(
            currentFieldCell.equals(nextFieldCell),
            UInt64.from(0),
            UInt64.from(1),
          ),
        );

        assert(
          addedCellsNum.lessThanOrEqual(UInt64.from(1)),
          `Exactly one cell should be added. Error at ${i}, ${j}`,
        );
        assert(
          Provable.if(
            currentFieldCell.equals(nextFieldCell),
            Bool(true),
            nextFieldCell.equals(currentUserId),
          ),
          'Added opponent`s color',
        );

        for (let wi = 0; wi < CELLS_LINE_TO_WIN; wi++) {
          const winPosX = winWitness.directionX
            .mul(UInt32.from(wi))
            .add(winWitness.x);
          const winPosY = winWitness.directionY
            .mul(UInt32.from(wi))
            .add(winWitness.y);
          assert(
            Bool.or(
              winProposed.not(),
              Provable.if(
                Bool.and(
                  winPosX.equals(UInt32.from(i)),
                  winPosY.equals(UInt32.from(j)),
                ),
                nextFieldCell.equals(currentUserId),
                Bool(true),
              ),
            ),
            'Win not proved',
          );
        }
      }
    }

    game.value.winner = Provable.if(
      winProposed,
      game.value.currentMoveUser,
      PublicKey.empty(),
    );

    this.pendingBalances.set(sender, ProtoUInt64.from(0));

    game.value.field = newField;
    game.value.currentMoveUser = Provable.if(
      game.value.currentMoveUser.equals(game.value.player1),
      game.value.player2,
      game.value.player1,
    );
    game.value.lastMoveBlockHeight = this.network.block.height;
    this.games.set(gameId, game.value);

    // Removing active game for players if game ended
    this.activeGameId.set(
      Provable.if(winProposed, game.value.player2, PublicKey.empty()),
      UInt64.from(0),
    );
    this.activeGameId.set(
      Provable.if(winProposed, game.value.player1, PublicKey.empty()),
      UInt64.from(0),
    );
  }

  @runtimeMethod()
  public win(gameId: UInt64): void {
    let game = this.games.get(gameId).value;
    assert(game.winner.equals(PublicKey.empty()).not());
    this.getFunds(gameId, game.winner, PublicKey.empty(), ProtoUInt64.from(1), ProtoUInt64.from(0));
  }
}
