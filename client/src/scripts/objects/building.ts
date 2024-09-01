import { Container, Graphics } from "pixi.js";
import { getEffectiveZIndex, ObjectCategory, ZIndexes } from "../../../../common/src/constants";
import { type BuildingDefinition } from "../../../../common/src/definitions/buildings";
import { type Orientation } from "../../../../common/src/typings";
import { CircleHitbox, GroupHitbox, PolygonHitbox, RectangleHitbox, type Hitbox } from "../../../../common/src/utils/hitbox";
import { adjacentOrEqualLayer, equalLayer, isGroundLayer } from "../../../../common/src/utils/layer";
import { Angle, Collision, EaseFunctions, type CollisionResponse } from "../../../../common/src/utils/math";
import { type ObjectsNetData } from "../../../../common/src/utils/objectsSerializations";
import { randomBoolean, randomFloat, randomRotation } from "../../../../common/src/utils/random";
import { Vec, type Vector } from "../../../../common/src/utils/vector";
import { type Game } from "../game";
import { type GameSound } from "../managers/soundManager";
import { DIFF_LAYER_HITBOX_OPACITY, HITBOX_COLORS, HITBOX_DEBUG_MODE } from "../utils/constants";
import { drawGroundGraphics, drawHitbox, SuroiSprite, toPixiCoords } from "../utils/pixi";
import { type Tween } from "../utils/tween";
import { GameObject } from "./gameObject";
import { MaterialSounds } from "../../../../common/src/definitions/obstacles";

export class Building extends GameObject.derive(ObjectCategory.Building) {
    readonly ceilingContainer: Container;

    definition!: BuildingDefinition;

    hitbox?: Hitbox;

    graphics?: Graphics;

    ceilingHitbox?: Hitbox;
    ceilingTween?: Tween<Container>;

    orientation!: Orientation;

    ceilingVisible = false;

    errorSeq?: boolean;

    sound?: GameSound;

    particleFrames!: string[];

    hitSound?: GameSound;

    constructor(game: Game, id: number, data: ObjectsNetData[ObjectCategory.Building]) {
        super(game, id);

        this.ceilingContainer = new Container();
        this.game.camera.addObject(this.ceilingContainer);

        this.layer = data.layer;
        this.container.zIndex = getEffectiveZIndex(ZIndexes.BuildingsFloor, this.layer);

        this.updateFromData(data, true);
    }

    toggleCeiling(): void {
        if (this.ceilingHitbox === undefined || this.ceilingTween || this.dead) return;
        const player = this.game.activePlayer;
        if (player === undefined) return;

        let visible = false;

        let duration = 150;

        if (this.ceilingHitbox.collidesWith(player.hitbox)) {
            visible = true;
            duration = !isGroundLayer(player.layer) ? 0 : 150; // We do not want a ceiling tween during the layer change.
        } else {
            const visionSize = 14;

            const playerHitbox = new CircleHitbox(visionSize, player.position);

            const hitboxes = this.ceilingHitbox instanceof GroupHitbox ? this.ceilingHitbox.hitboxes : [this.ceilingHitbox];

            let graphics: Graphics | undefined;
            if (HITBOX_DEBUG_MODE) {
                graphics = new Graphics();
                graphics.zIndex = 100;
                this.game.camera.addObject(graphics);
            }

            for (const hitbox of hitboxes) {
                // find the direction to cast rays
                let collision: CollisionResponse = null;

                switch (true) {
                    case hitbox instanceof CircleHitbox: {
                        collision = Collision.circleCircleIntersection(
                            hitbox.position,
                            hitbox.radius,
                            playerHitbox.position,
                            playerHitbox.radius
                        );
                        break;
                    }
                    case hitbox instanceof RectangleHitbox: {
                        collision = Collision.rectCircleIntersection(
                            hitbox.min,
                            hitbox.max,
                            playerHitbox.position,
                            playerHitbox.radius
                        );
                        break;
                    }
                    case hitbox instanceof PolygonHitbox: {
                        // TODO
                        break;
                    }
                }

                const direction = collision?.dir;
                if (direction) {
                    /* if (HITBOX_DEBUG_MODE) {
                        graphics?.lineStyle({
                            color: 0xff0000,
                            width: 0.1
                        });

                        graphics?.beginFill();
                        graphics?.scale.set(PIXI_SCALE);

                        this.addTimeout(() => {
                            graphics?.destroy();
                        }, 30);
                    } */

                    const angle = Math.atan2(direction.y, direction.x);

                    let collided = false;

                    const halfPi = Math.PI / 2;
                    for (let i = angle - halfPi; i < angle + halfPi; i += 0.1) {
                        collided = false;

                        const end = this.ceilingHitbox.intersectsLine(
                            player.position,
                            Vec.add(
                                player.position,
                                Vec.scale(
                                    Vec.create(Math.cos(i), Math.sin(i)),
                                    visionSize
                                )
                            )
                        )?.point;

                        if (!end) {
                            // what's the point of this assignment?
                            collided = true;
                            continue;
                        }

                        if (graphics) {
                            graphics.moveTo(player.position.x, player.position.y);
                            graphics.lineTo(end.x, end.y);
                            graphics.fill();
                        }

                        if (!(
                            collided
                                ||= [
                                    ...this.game.objects.getCategory(ObjectCategory.Obstacle),
                                    ...this.game.objects.getCategory(ObjectCategory.Building)
                                ].some(
                                    ({ damageable, dead, definition, hitbox }) =>
                                        damageable
                                        && !dead
                                        && (!("role" in definition) || !definition.isWindow)
                                        && hitbox?.intersectsLine(player.position, end)
                                )
                        )) break;
                    }
                    visible = !collided;
                } else {
                    visible = false;
                }

                if (visible) break;
            }
        }

        if (this.ceilingVisible === visible) return;

        this.ceilingVisible = visible;

        this.ceilingTween = this.game.addTween({
            target: this.ceilingContainer,
            to: { alpha: visible ? 0 : 1 },
            duration: visible ? duration : 300,
            ease: EaseFunctions.sineOut,
            onComplete: () => {
                this.ceilingTween = undefined;
            }
        });
    }

    override updateFromData(data: ObjectsNetData[ObjectCategory.Building], isNew = false): void {
        if (data.full) {
            const full = data.full;
            const definition = this.definition = full.definition;
            this.position = full.position;

            // If there are multiple particle variations, generate a list of variation image names
            const particleImage = definition.particle ?? `${definition.idString}_particle`;

            this.particleFrames = definition.particleVariations !== undefined
                ? Array.from({ length: definition.particleVariations }, (_, i) => `${particleImage}_${i + 1}`)
                : [particleImage];

            for (const image of definition.floorImages) {
                const sprite = new SuroiSprite(image.key);
                sprite.setVPos(toPixiCoords(image.position));
                if (image.tint !== undefined) sprite.setTint(image.tint);
                if (image.rotation) sprite.setRotation(image.rotation);
                if (image.scale) sprite.scale = image.scale;
                this.container.addChild(sprite);
            }

            this.layer = data.layer;
            const pos = toPixiCoords(this.position);
            this.container.position.copyFrom(pos);
            this.ceilingContainer.position.copyFrom(pos);
            this.ceilingContainer.zIndex = getEffectiveZIndex(
                definition.ceilingZIndex,
                this.layer + Math.max( // make sure the ceiling appears over everything else
                    ...this.definition.obstacles.map(({ layer }) => layer ?? 0),
                    ...this.definition.subBuildings.map(({ layer }) => layer ?? 0)
                )
            );

            this.orientation = full.orientation;
            this.rotation = Angle.orientationToRotation(this.orientation);
            this.container.rotation = this.rotation;
            this.ceilingContainer.rotation = this.rotation;

            if (definition.graphics.length) {
                this.graphics = new Graphics();
                this.graphics.zIndex = getEffectiveZIndex(definition.graphicsZIndex, this.layer);
                for (const graphics of definition.graphics) {
                    this.graphics.beginPath();
                    drawGroundGraphics(graphics.hitbox.transform(this.position, 1, this.orientation), this.graphics);
                    this.graphics.closePath();
                    this.graphics.fill(graphics.color);
                }
                this.game.camera.container.addChild(this.graphics);
            }

            this.hitbox = definition.hitbox?.transform(this.position, 1, this.orientation);
            this.damageable = !!definition.hitbox;
            this.ceilingHitbox = (definition.scopeHitbox ?? definition.ceilingHitbox)?.transform(this.position, 1, this.orientation);
        }

        const definition = this.definition;

        if (definition === undefined) {
            console.warn("Building partially updated before being fully updated");
        }

        if (definition.sounds) {
            const { sounds } = definition;
            const soundOptions = {
                position: Vec.add(Vec.rotate(sounds.position ?? Vec.create(0, 0), this.rotation), this.position),
                fallOff: sounds.falloff,
                maxRange: sounds.maxRange,
                dynamic: true,
                loop: true
            };

            if (
                sounds.normal
                && !data.puzzle?.solved
                && this.sound?.name !== sounds.normal
            ) {
                this.sound?.stop();
                this.sound = this.game.soundManager.play(sounds.normal, soundOptions);
            }

            if (
                sounds.solved
                && data.puzzle?.solved
                && this.sound?.name !== sounds.solved
            ) {
                this.sound?.stop();
                this.sound = this.game.soundManager.play(sounds.solved, soundOptions);
            }
        }

        if (data.dead) {
            if (!this.dead && !isNew) {
                this.game.particleManager.spawnParticles(10, () => ({
                    frames: `${definition.idString}_particle`,
                    position: this.ceilingHitbox?.randomPoint() ?? { x: 0, y: 0 },
                    zIndex: Math.max(ZIndexes.Players + 1, 4),
                    layer: this.layer,
                    lifetime: 2000,
                    rotation: {
                        start: randomRotation(),
                        end: randomRotation()
                    },
                    alpha: {
                        start: 1,
                        end: 0,
                        ease: EaseFunctions.sexticIn
                    },
                    scale: { start: 1, end: 0.2 },
                    speed: Vec.fromPolar(randomRotation(), randomFloat(1, 2))
                }));

                this.playSound(
                    "ceiling_collapse",
                    {
                        falloff: 0.5,
                        maxRange: 96
                    }
                );
            }
            this.ceilingTween?.kill();
            this.ceilingContainer.zIndex = getEffectiveZIndex(ZIndexes.DeadObstacles, this.layer);
            this.ceilingContainer.alpha = 1;

            this.ceilingContainer.addChild(new SuroiSprite(`${definition.idString}_residue`));
        }
        this.dead = data.dead;

        if (data.puzzle) {
            if (!isNew && data.puzzle.errorSeq !== this.errorSeq) {
                this.playSound("puzzle_error");
            }
            this.errorSeq = data.puzzle.errorSeq;

            if (!isNew && data.puzzle.solved && definition.puzzle?.solvedSound) {
                this.playSound("puzzle_solved");
            }
        }

        this.ceilingContainer.removeChildren();
        for (const image of definition.ceilingImages) {
            let key = image.key;
            if (this.dead && image.residue) key = image.residue;
            const sprite = new SuroiSprite(key);

            if (this.dead && key !== image.residue) sprite.setVisible(false);

            sprite.setVPos(toPixiCoords(image.position));
            if (image.rotation) sprite.setRotation(image.rotation);
            if (image.scale) sprite.scale = image.scale;
            if (image.tint !== undefined) sprite.setTint(image.tint);
            this.ceilingContainer.addChild(sprite);
        }

        this.updateDebugGraphics();
    }

    override updateDebugGraphics(): void {
        if (!HITBOX_DEBUG_MODE) return;

        const definition = this.definition;
        const alpha = this.layer === this.game.activePlayer?.layer as number | undefined ? 1 : DIFF_LAYER_HITBOX_OPACITY;
        this.debugGraphics.clear();

        if (this.hitbox) {
            drawHitbox(
                this.hitbox,
                HITBOX_COLORS.obstacle,
                this.debugGraphics,
                this.game.activePlayer !== undefined && (definition.spanAdjacentLayers ? adjacentOrEqualLayer : equalLayer)(this.layer, this.game.activePlayer.layer) ? 1 : DIFF_LAYER_HITBOX_OPACITY
            );
        }

        if (this.ceilingHitbox) {
            drawHitbox(
                this.ceilingHitbox,
                HITBOX_COLORS.buildingScopeCeiling,
                this.debugGraphics
            );
        }

        drawHitbox(
            definition.spawnHitbox.transform(this.position, 1, this.orientation),
            HITBOX_COLORS.spawnHitbox,
            this.debugGraphics,
            alpha
        );

        if (definition.scopeHitbox) {
            drawHitbox(
                definition.scopeHitbox.transform(this.position, 1, this.orientation),
                HITBOX_COLORS.buildingZoomCeiling,
                this.debugGraphics
            );
        }

        for (const { collider, layer } of definition.visibilityOverrides ?? []) {
            drawHitbox(
                collider.transform(this.position, 1, this.orientation),
                HITBOX_COLORS.buildingVisOverride,
                this.debugGraphics,
                layer === this.game.activePlayer?.layer as number | undefined ? 1 : DIFF_LAYER_HITBOX_OPACITY
            );
        }
    }

    hitEffect(position: Vector, angle: number): void {
        this.game.particleManager.spawnParticle({
            frames: this.particleFrames,
            position,
            zIndex: ZIndexes.Players + 1,
            layer: this.layer,
            lifetime: 600,
            scale: { start: 0.9, end: 0.2 },
            alpha: { start: 1, end: 0.65 },
            speed: Vec.fromPolar((angle + randomFloat(-0.3, 0.3)), randomFloat(2.5, 4.5))
        });

        this.hitSound?.stop();
        const { material } = this.definition;
        if (!material) return;
        this.hitSound = this.game.soundManager.play(
            `${MaterialSounds[material]?.hit ?? material}_hit_${randomBoolean() ? "1" : "2"}`,
            {
                position,
                falloff: 0.2,
                maxRange: 96
            }
        );
    }

    override destroy(): void {
        super.destroy();

        this.graphics?.destroy();
        this.ceilingTween?.kill();
        this.ceilingContainer.destroy();
        this.sound?.stop();
    }
}
