import type { IDomainEvent, IEventBus } from "../domains/investigation/interfaces.js";
import { EventBus } from "./EventBus.js";

export class InProcessEventBus extends EventBus<IDomainEvent> implements IEventBus {}
