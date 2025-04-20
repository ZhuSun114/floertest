import { type WebSocket } from "ws";
import { ServerEntity } from "./serverEntity";
import { Vec2 } from "../../../common/src/utils/vector";
import { GameBitStream, type Packet, PacketStream } from "../../../common/src/net";
import { type Game } from "../game";
import { type EntitiesNetData, PlayerState, UpdatePacket } from "../../../common/src/packets/updatePacket";
import { CircleHitbox, RectHitbox } from "../../../common/src/utils/hitbox";
import { Random } from "../../../common/src/utils/random";
import { MathNumeric } from "../../../common/src/utils/math";
import { InputPacket } from "../../../common/src/packets/inputPacket";
import { JoinPacket } from "../../../common/src/packets/joinPacket";
import { EntityType, GameConstants } from "../../../common/src/constants";
import { GameOverPacket } from "../../../common/src/packets/gameOverPacket";
import { Inventory } from "../inventory/inventory";
import { ServerPetal } from "./serverPetal";
import { PetalDefinition, SavedPetalDefinitionData } from "../../../common/src/definitions/petal";
import { spawnLoot } from "../utils/loot";
import { AttributeEvents } from "../utils/attribute";
import { PlayerModifiers } from "../../../common/src/typings";
import { EventFunctionArguments } from "../utils/eventManager";
import { getLevelExpCost, getLevelInformation } from "../../../common/src/utils/levels";
import { damageableEntity, damageSource } from "../typings";
import { LoggedInPacket } from "../../../common/src/packets/loggedInPacket";
import { ServerFriendlyMob } from "./serverMob";

export class ServerPlayer extends ServerEntity<EntityType.Player> {
    type: EntityType.Player = EntityType.Player;
    socket: WebSocket;

    hitbox = new CircleHitbox(GameConstants.player.radius);

    name = "";
    direction = Vec2.new(0, 0);
    distance: number = 0;
    isAttacking = false;
    isDefending = false;

    inventory: Inventory;

    joined: boolean = false;

    damage: number = GameConstants.player.defaultBodyDamage;

    private _health = GameConstants.player.defaultHealth;

    get health(): number {
        return this._health;
    }

    set health(health: number) {
        if (health === this._health) return;
        this._health = MathNumeric.clamp(health, 0, this.modifiers.maxHealth);
        this.setFullDirty();
    }

    private _maxHealth = GameConstants.player.defaultHealth;

    get maxHealth(): number {
        return this._maxHealth;
    }

    set maxHealth(maxHealth: number) {
        if (maxHealth === this._maxHealth) return;
        this._health = MathNumeric.clamp(this._health  * maxHealth / this._maxHealth, 0, maxHealth);
        this._maxHealth = maxHealth;

        this.setFullDirty();
    }

    kills = 0;

    firstPacket = true;

    /**
    * Entities the player can see
    */
    visibleEntities = new Set<ServerEntity>();

    // what needs to be sent again to the client
    readonly dirty = {
        id: true,
        zoom: true,
        inventory: false,
        slot: false,
        exp: false,
        overleveled: false
    };

    private _zoom = 45;

    get zoom(): number {
        return this._zoom;
    }

    set zoom(zoom: number) {
        if (this._zoom === zoom) return;
        this._zoom = zoom;
        this.dirty.zoom = true;
    }

    get petalEntities(): ServerPetal[]{
        return this.inventory.petalBunches
            .reduce(
                (pre, petalBunch) =>
                    pre.concat(petalBunch.petals),
                [] as ServerPetal[]
            )
    }

    modifiers: PlayerModifiers = GameConstants.player.defaultModifiers();
    otherModifiers: Partial<PlayerModifiers>[] = [];

    exp: number = 0;
    level: number = 1;

    overleveled: boolean = false;
    overleveledTimeRemains: number = GameConstants.player.overleveledTime;

    chatMessagesToSend: string[] = [];

    canReceiveDamageFrom(source: damageableEntity): boolean {
        switch (source.type) {
            case EntityType.Player:
                return source != this
            case EntityType.Mob:
                if (source instanceof ServerFriendlyMob) return source.owner !== this;
                return true
            case EntityType.Petal:
                return source.owner != this;
            case EntityType.Projectile:
                if (source.source instanceof ServerFriendlyMob) return source.source.owner != this;
                return source.source != this;
        }
    }

    constructor(game: Game, socket: WebSocket) {
        const position = Random.vector(
            0,
            GameConstants.player.spawnMaxX,
            0,
            GameConstants.player.spawnMaxY
        );
        super(game, position);
        this.position = position;
        this.socket = socket;

        this.inventory = new Inventory(this);

        this.updateModifiers();
    }

    tick(): void {
        super.tick();

        this.setAcceleration(Vec2.mul(
            this.direction,
            MathNumeric.remap(this.distance, 0, 150, 0, GameConstants.player.maxSpeed) * this.modifiers.speed
        ));

        this.inventory.range = GameConstants.player.defaultPetalDistance;

        if (this.isDefending) {
            this.sendEvent(AttributeEvents.DEFEND, undefined)
            this.inventory.range = GameConstants.player.defaultPetalDefendingDistance;
        }

        if (this.isAttacking) {
            this.sendEvent(AttributeEvents.ATTACK, undefined)
            this.inventory.range = GameConstants.player.defaultPetalAttackingDistance;
        }

        this.inventory.tick();

        if (this.health < this.modifiers.maxHealth)
            this.sendEvent(AttributeEvents.HEALING, undefined)

        this.heal(this.modifiers.healPerSecond * this.game.dt);

        if (this.modifiers.selfPoison > 0) {
            this.receiveDamage(this.modifiers.selfPoison * this.game.dt, this, true);
        }

        this.updateModifiers();

        if (this.level >= this.game.inWhichZone(this).levelAtHighest) {
            this.dirty.overleveled = true;
            this.overleveledTimeRemains -= this.game.dt;
            this.overleveled = this.overleveledTimeRemains <= 0;
        } else {
            this.overleveled = false;
            if (this.overleveledTimeRemains <= GameConstants.player.overleveledTime) {
                this.overleveledTimeRemains += this.game.dt / 10;
            }
        }
    }

    addExp(exp: number) {
        this.exp += exp;
        this.dirty.exp = true;
        this.level = getLevelInformation(this.exp).level;
    }

    dealDamageTo(to: damageableEntity): void{
        if (to.canReceiveDamageFrom(this)) {
            to.receiveDamage(this.damage, this);
            this.sendEvent(
                AttributeEvents.FLOWER_DEAL_DAMAGE, to
            )
        }
    }

    receiveDamage(amount: number, source: damageSource, disableEvent?: boolean) {
        if (!this.isActive()) return;

        // 闪避
        if (this.modifiers.damageAvoidanceChance > 0 && Math.random() < this.modifiers.damageAvoidanceChance) {
            //console.log(`Player ${this.name} avoided damage from ${source.type}`);
            return;
        }

        this.health -= amount;

        if (!disableEvent) {
            this.sendEvent(
                AttributeEvents.FLOWER_GET_DAMAGE, {
                    entity: source,
                    damage: amount,
                }
            )
        }

        this.gotDamage = true;

        if (this.health <= 0) {
            this.destroy();

            if (source instanceof ServerPlayer){
                source.addExp(this.exp / 2)
            }

            if (source instanceof ServerPlayer) source.kills++;

            const gameOverPacket = new GameOverPacket();
            gameOverPacket.kills = this.kills;
            gameOverPacket.murderer = source.name;
            this.addPacketToSend(gameOverPacket);
        }
    }

    heal(amount: number) {
        amount *= this.modifiers.healing;
        this.health += amount;
    }

    sendPackets() {
        if (!this.joined) return;

        // calculate visible, deleted, and dirty entities
        // and send them to the client
        const updatePacket = new UpdatePacket();

        const radius = this.zoom + 10;
        const rect = RectHitbox.fromCircle(radius, this.position);
        const newVisibleEntities = this.game.grid.intersectsHitbox(rect);

        for (const entity of this.visibleEntities) {
            if (!newVisibleEntities.has(entity)) {
                updatePacket.deletedEntities.push(entity.id);
            }
        }

        for (const entity of newVisibleEntities) {
            if (!this.visibleEntities.has(entity)) {
                updatePacket.serverFullEntities.push(entity);
            }
        }

        for (const entity of this.game.fullDirtyEntities) {
            if (newVisibleEntities.has(entity)
                && !updatePacket.serverFullEntities.includes(entity)
                && !updatePacket.deletedEntities.includes(entity.id)) {
                updatePacket.serverFullEntities.push(entity);
            }
        }

        for (const entity of this.game.partialDirtyEntities) {
            if (newVisibleEntities.has(entity)
                && !updatePacket.serverFullEntities.includes(entity)
                && !updatePacket.deletedEntities.includes(entity.id)) {
                updatePacket.serverPartialEntities.push(entity);
            }
        }
        this.visibleEntities = newVisibleEntities;

        updatePacket.playerData.zoom = this.zoom;
        updatePacket.playerData.id = this.id;
        updatePacket.playerData.inventory = ([] as SavedPetalDefinitionData[])
            .concat(this.inventory.inventory);
        updatePacket.playerData.slot = this.inventory.slot;
        updatePacket.playerData.exp = this.exp;
        updatePacket.playerData.overleveled = this.overleveledTimeRemains;

        updatePacket.playerDataDirty = this.dirty;

        updatePacket.players = [...this.game.activePlayers];

        updatePacket.map.width = this.game.width;
        updatePacket.map.height = this.game.height;
        updatePacket.mapDirty = this.firstPacket ?? this.game.mapDirty;


        updatePacket.chatDirty = this.chatMessagesToSend.length > 0;
        updatePacket.chatMessages = this.chatMessagesToSend.concat([]);

        this.firstPacket = false;

        this.addPacketToSend(updatePacket);
        this.send();

        this.chatMessagesToSend = [];
    }

    packetStream = new PacketStream(GameBitStream.create(1 << 16));

    readonly packetsToSend: Packet[] = [];

    send(): void{
        this.packetStream.stream.index = 0;

        for (const packet of this.packetsToSend) {
            this.packetStream.serializeServerPacket(packet);
        }

        this.packetsToSend.length = 0;
        const buffer = this.packetStream.getBuffer();
        this.sendData(buffer);
    }

    addPacketToSend(packet: Packet): void {
        this.packetsToSend.push(packet);
    }

    sendData(data: ArrayBuffer): void {
        try {
            this.socket.send(data);
        } catch (error) {
            console.error("Error sending data:", error);
        }
    }

    processMessage(message: ArrayBuffer): void {
        const packetStream = new PacketStream(message);

        const packet = packetStream.deserializeClientPacket();

        if (packet === undefined) return;

        switch (true) {
            case packet instanceof JoinPacket: {
                this.join(packet);
                break;
            }
            case packet instanceof InputPacket: {
                this.processInput(packet);
                break;
            }
        }
    }

    join(packet: JoinPacket): void {
        this.name = packet.name.trim();
        if (!this.name) this.name = GameConstants.player.defaultName;

        this.game.activePlayers.add(this);
        this.game.grid.addEntity(this);

        this.petalEntities.map(e => e.join());

        console.log(`"${this.name}" joined the game`);

        this.updateModifiers();

        const loggedIn = new LoggedInPacket();
        loggedIn.inventory = this.inventory.inventory;
        this.addPacketToSend(loggedIn);

        this.send();

        this.joined = true;

        if (this.inventory.inventory.length) {
            this.inventory.loadConfigByData(this.inventory.inventory);
        } else {
            this.inventory.loadDefaultConfig();
        }
    }

    processInput(packet: InputPacket): void {
        if (!this.isActive()) return;

        // if the direction changed set to dirty
        if (!Vec2.equals(this.direction, Vec2.radiansToDirection(packet.direction))) {
            this.setDirty();
        }
        this.direction = Vec2.radiansToDirection(packet.direction);
        this.distance = packet.mouseDistance;
        this.isAttacking = packet.isAttacking;
        this.isDefending = packet.isDefending;
        this.inventory.switchPetal(packet.switchedPetalIndex, packet.switchedToPetalIndex);
        this.inventory.delete(packet.deletedPetalIndex);

        if (packet.chat) {
            this.sendChatMessage(packet.chat)
        }
    }

    sendEvent<T extends AttributeEvents>(
        event: T, data: EventFunctionArguments[T], petal?: ServerPetal
    ) {
        if (!petal){
            return this.inventory.eventManager.sendEvent<T>(event, data);
        }
        this.inventory.eventManager.sendEventByPetal<T>(petal, event, data);
    }

    get playerState(): PlayerState {
        if (this.state.poison) return PlayerState.Poisoned;
        if (this.modifiers.healing < 1) return PlayerState.Danded;
        if (this.isAttacking) return PlayerState.Attacking;
        if (this.isDefending) return PlayerState.Defending;
        return PlayerState.Normal
    }

    gotDamage: boolean = false;

    get data(): Required<EntitiesNetData[EntityType.Player]> {
        const data = {
            position: this.position,
            direction: this.direction,
            state: this.playerState,
            gotDamage: this.gotDamage,
            full: {
                healthPercent: this.health / this.maxHealth
            }
        };

        this.gotDamage = false;
        return data;
    }

    calcModifiers(now: PlayerModifiers, extra: Partial<PlayerModifiers>): PlayerModifiers {
        now.healing *= extra.healing ?? 1;
        now.maxHealth += extra.maxHealth ?? 0;
        now.healPerSecond += extra.healPerSecond ?? 0;
        now.speed *= extra.speed ?? 1;
        now.revolutionSpeed += extra.revolutionSpeed ?? 0;
        now.zoom += extra.zoom ?? 0;
        now.damageAvoidanceChance += extra.damageAvoidanceChance ?? 0;
        now.selfPoison += extra.selfPoison ?? 0;

        return now;
    }

    updateModifiers(): void {
        let modifiersNow = GameConstants.player.defaultModifiers();

        let effectedPetals: PetalDefinition[] = []

        // 闪避
        let avoidanceFailureChance = 1;

        for (const petal of this.petalEntities) {
            const modifier = petal.definition.modifiers;
            if (modifier && !petal.isLoadingFirstTime) {
                if (petal.definition.unstackable && effectedPetals.includes(petal.definition)) continue;
                if (modifier.damageAvoidanceChance) {
                    avoidanceFailureChance *= (1 - modifier.damageAvoidanceChance);
                    const modifierWithoutAvoidance = {...modifier};
                    delete modifierWithoutAvoidance.damageAvoidanceChance;

                    modifiersNow = this.calcModifiers(modifiersNow, modifierWithoutAvoidance);
                } else {
                    modifiersNow = this.calcModifiers(modifiersNow, modifier);
                }

                effectedPetals.push(petal.definition)
            }
        }

        this.effects.effects.forEach(effect => {
            if (effect.modifier) {
                if (effect.modifier.damageAvoidanceChance) {
                    avoidanceFailureChance *= (1 - effect.modifier.damageAvoidanceChance);
                    const modifierWithoutAvoidance = {...effect.modifier};
                    delete modifierWithoutAvoidance.damageAvoidanceChance;
                    modifiersNow = this.calcModifiers(modifiersNow, modifierWithoutAvoidance);
                } else {
                    modifiersNow = this.calcModifiers(modifiersNow, effect.modifier);
                }
            }
        })

        this.otherModifiers.forEach(effect => {
            if (effect.damageAvoidanceChance) {
                avoidanceFailureChance *= (1 - effect.damageAvoidanceChance);
                const modifierWithoutAvoidance = {...effect};
                delete modifierWithoutAvoidance.damageAvoidanceChance;
                modifiersNow = this.calcModifiers(modifiersNow, modifierWithoutAvoidance);
            } else {
                modifiersNow = this.calcModifiers(modifiersNow, effect);
            }
        })

        this.otherModifiers = [];

        modifiersNow.damageAvoidanceChance = 1 - avoidanceFailureChance;

        this.modifiers = modifiersNow;

        this.maxHealth = this.modifiers.maxHealth;
        this.zoom = this.modifiers.zoom;
    }

    destroy() {
        if (this.destroyed) return;
        super.destroy();
        for (const i of this.petalEntities){
            i.destroy();
        }
        spawnLoot(
            this.game,
            this.inventory.drop(3),
            this.position
        )

        this.exp = getLevelExpCost(Math.floor(this.level * 0.75) + 1);

        this.dirty.inventory = true;
        this.dirty.exp = true;

        this.game.activePlayers.delete(this);
    }

    sendChatMessage(message: string): void {
        const radius = 50;
        const collided =
            this.game.grid.intersectsHitbox(new CircleHitbox(radius, this.position));

        const modifiedMessage = `[Local] ${this.name}: ${message}`;

        for (const collidedElement of collided) {
            if (!(collidedElement instanceof ServerPlayer)) continue;
            collidedElement.chatMessagesToSend.push(modifiedMessage);
        }
    }
}
