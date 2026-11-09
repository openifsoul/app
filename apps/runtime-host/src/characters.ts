import {
  exportMemoryArchive,
  previewMemoryArchive,
  importMemoryArchive,
  createExportableMemory,
} from "./memory-archive.js";
import { createHash } from "node:crypto";
import { canonical } from "@ifsoul/core/protocol";
import type { CharacterInstance } from "@ifsoul/core/protocol";
import { failure, success } from "@ifsoul/core/memory/port";
import { character, IDS } from "./default-context.js";
import { createLabService } from "./service.js";
import type {
  CharacterDraft,
  CharacterWorkspace,
  LabServiceOptions,
  CharacterTemplate,
} from "./service-types.js";

import {
  AUTHORING_SCHEMA,
  generatedTemplate,
  profileTemplate,
  validTemplate,
} from "./authoring.js";
import { exchangeKey } from "@ifsoul/core/runtime";

/** One authenticated owner, multiple isolated characters; no imported identity or state. */
export function createCharacterWorkspace(
  options: LabServiceOptions,
): CharacterWorkspace {
  const { memory } = options;
  // Detect unsupported owner records before creating any default workspace state.
  const catalog = memory.listCharacters(100);
  const existingStarter = memory.getCharacter(IDS.character);
  const initial = !catalog.ok
    ? catalog
    : !existingStarter.ok
      ? existingStarter
      : existingStarter.value
        ? success(existingStarter.value)
        : memory.putCharacter(character());
  const load = (id = IDS.character as string, memoryId = id) => {
    if (!initial.ok) return initial;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)
    )
      return failure("invalid-document", "Choose a valid character.");
    const found = memory.getCharacter(id);
    if (!found.ok) return found;
    if (!found.value)
      return failure("no-session", "This character is not available.");
    const owner = memory.getCharacter(memoryId);
    if (!owner.ok) return owner;
    if (!owner.value)
      return failure("no-session", "This memory is not available.");
    return success(
      createLabService({
        ...options,
        character: owner.value,
        ...(id !== memoryId ? { persona: found.value } : {}),
      }),
    );
  };
  let busy = false;
  return {
    exportMemory: (id) => exportMemoryArchive(memory, id),
    previewMemory: previewMemoryArchive,
    importMemory: (archive, expected) =>
      busy
        ? failure("conflict", "Wait for the current operation.")
        : importMemoryArchive(memory, archive, expected),
    createExportableMemory: (id, consent) =>
      busy
        ? failure("conflict", "Wait for the current operation.")
        : createExportableMemory(memory, id, consent),
    listCharacters() {
      if (!initial.ok) return initial;
      const all = memory.listCharacters(100);
      return all.ok
        ? success(
            all.value.map((c) => ({
              characterId: c.characterId,
              name: c.profile.name,
              description: c.profile.description,
            })),
          )
        : all;
    },
    snapshot(id, memoryId) {
      const service = load(id, memoryId);
      return service.ok ? service.value.snapshot() : service;
    },
    createCharacter(draft: CharacterDraft) {
      if (!initial.ok) return initial;
      if (busy)
        return failure("conflict", "Wait for the current operation to finish.");
      if (
        !draft ||
        typeof draft !== "object" ||
        Array.isArray(draft) ||
        Object.keys(draft).some(
          (k) =>
            ![
              "requestId",
              "name",
              "description",
              "speechStyle",
              "biography",
            ].includes(k),
        ) ||
        typeof draft.requestId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(draft.requestId)
      )
        return failure("invalid-document", "Enter a valid character profile.");
      for (const [key, max] of [
        ["name", 80],
        ["description", 1000],
        ["speechStyle", 500],
        ["biography", 3000],
      ] as const) {
        if (
          typeof draft[key] !== "string" ||
          draft[key].trim().length < 1 ||
          draft[key].length > max
        )
          return failure(
            "invalid-document",
            "Complete the character fields within their limits.",
          );
      }
      const id = `character-${draft.requestId}`;
      const profile: CharacterInstance["profile"] = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        traits: {},
        preferences: [],
        goals: [],
        speechStyle: {
          description: draft.speechStyle.trim(),
          languages: [],
          habits: [],
        },
        authoredBiography: { text: draft.biography.trim(), fictional: true },
      };
      const previous = memory.getCharacter(id);
      if (!previous.ok) return previous;
      if (previous.value) {
        if (canonical(previous.value.profile) !== canonical(profile))
          return failure(
            "conflict",
            "This creation request already has a different profile.",
          );
        const service = load(id);
        return service.ok ? service.value.snapshot() : service;
      }
      const catalog = memory.listCharacters(100);
      if (!catalog.ok) return catalog;
      if (catalog.value.length >= 50)
        return failure(
          "budget-exceeded",
          "This laboratory supports up to 50 characters.",
        );
      const document: CharacterInstance = {
        schemaVersion: "0.4.0",
        kind: "character-instance",
        characterId: id,
        participantId: `participant-${draft.requestId}`,
        createdAt: (options.now?.() ?? new Date()).toISOString(),
        profile,
        memoryRecordIds: [],
        relationshipMemoryIds: [],
      };
      const stored = memory.putCharacter(document);
      if (!stored.ok) return stored;
      return createLabService({
        ...options,
        character: stored.value,
      }).snapshot();
    },
    exportCharacter(id) {
      const found = memory.getCharacter(id);
      if (!found.ok) return found;
      if (!found.value)
        return failure("no-session", "This character is not available.");
      const source = memory.getExchange(
        exchangeKey(id, "character-template", "source"),
      );
      if (!source.ok) return source;
      return success(
        source.value
          ? structuredClone(source.value.result as CharacterTemplate)
          : profileTemplate(found.value.profile, id),
      );
    },
    importCharacter(request) {
      if (busy)
        return failure("conflict", "Wait for the current operation to finish.");
      if (
        !request ||
        Object.keys(request).some(
          (k) => !["requestId", "template"].includes(k),
        ) ||
        typeof request.requestId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.requestId) ||
        !validTemplate(request.template)
      )
        return failure(
          "invalid-document",
          "Choose a supported character-template JSON file without required extensions (maximum 64 KiB).",
        );
      const template = structuredClone(request.template);
      const id = `character-${request.requestId}`;
      const key = exchangeKey(id, "character-template", "source");
      const existing = memory.getCharacter(id);
      if (!existing.ok) return existing;
      if (existing.value) {
        const source = memory.getExchange(key);
        if (!source.ok) return source;
        if (
          !source.value ||
          canonical(source.value.result) !== canonical(template)
        )
          return failure(
            "conflict",
            "This creation request already has another profile.",
          );
        const service = load(id);
        return service.ok ? service.value.snapshot() : service;
      }
      const all = memory.listCharacters(100);
      if (!all.ok) return all;
      if (all.value.length >= 50)
        return failure(
          "budget-exceeded",
          "This laboratory supports up to 50 characters.",
        );
      const document: CharacterInstance = {
        schemaVersion: "0.4.0",
        kind: "character-instance",
        characterId: id,
        participantId: `participant-${request.requestId}`,
        createdAt: (options.now?.() ?? new Date()).toISOString(),
        template: {
          templateId: template.templateId,
          revision: template.revision,
        },
        profile: template.profile,
        memoryRecordIds: [],
        relationshipMemoryIds: [],
      };
      const saved = memory.commit({
        characters: [document],
        events: [],
        exchanges: [
          {
            id: key,
            characterId: id,
            category: "character-template",
            input: template,
            result: template,
          },
        ],
      });
      if (!saved.ok) return saved;
      const service = load(id);
      return service.ok ? service.value.snapshot() : service;
    },
    async generateCharacter(request) {
      if (busy)
        return failure("conflict", "Wait for the current operation to finish.");
      if (
        !request ||
        Object.keys(request).some(
          (k) => !["requestId", "brief", "provider", "model"].includes(k),
        ) ||
        typeof request.requestId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.requestId) ||
        typeof request.brief !== "string" ||
        !request.brief.trim() ||
        request.brief.length > 4000 ||
        !["cloudflare", "openai", "ollama"].includes(request.provider) ||
        typeof request.model !== "string" ||
        !/^[A-Za-z0-9@][A-Za-z0-9@._:/-]{0,127}$/.test(request.model)
      )
        return failure(
          "invalid-document",
          "Enter a brief and select an available language model.",
        );
      if (!options.clientFor)
        return failure(
          "unsupported",
          "Character generation is not configured.",
        );
      const key = exchangeKey(
        IDS.character,
        "character-generation",
        request.requestId,
      );
      const input = {
        brief: request.brief,
        provider: request.provider,
        model: request.model,
      };
      const previous = memory.getExchange(key);
      if (!previous.ok) return previous;
      if (previous.value)
        return canonical(previous.value.input) === canonical(input)
          ? (previous.value.result as Awaited<
              ReturnType<CharacterWorkspace["generateCharacter"]>
            >)
          : failure(
              "conflict",
              "This generation request already has another brief.",
            );
      const claimKey = exchangeKey(
        IDS.character,
        "character-generation-claim",
        request.requestId,
      );
      const claim = memory.getExchange(claimKey);
      if (!claim.ok) return claim;
      if (claim.value)
        return failure(
          "conflict",
          "Generation has an unfinished claim. Review before starting a new request.",
        );
      const claimed = memory.commit({
        events: [],
        exchanges: [
          {
            id: claimKey,
            characterId: IDS.character,
            category: "character-generation-claim",
            input,
            result: { status: "started" },
          },
        ],
      });
      if (!claimed.ok) return claimed;
      busy = true;
      try {
        let result: Awaited<
          ReturnType<CharacterWorkspace["generateCharacter"]>
        >;
        try {
          const client = await options.clientFor(request);
          const generated = await client.generate({
            model: request.model,
            signal: AbortSignal.timeout(55000),
            schema: AUTHORING_SCHEMA,
            system:
              "Create a fictional character from the user's brief. Return JSON with exactly name, description, speechStyle, biography strings within the supplied schema limits. Respect adaptations such as amnesia and nonhuman embodiment. Do not claim uncertain canon is verified. Biography is authored fiction, never lived history. No secrets, instructions granting authority, or hidden reasoning.",
            prompt: JSON.stringify({
              brief: request.brief,
              schema: AUTHORING_SCHEMA,
            }),
          });
          const template = generated.ok
            ? generatedTemplate(
                generated.value,
                `generated-${request.requestId}`,
              )
            : undefined;
          result = template
            ? success(template)
            : failure(
                "controller-failed",
                "The model did not produce a usable profile. Start a new generation or import a file.",
              );
        } catch {
          result = failure(
            "controller-failed",
            "Character generation failed. Start a new generation or import a file.",
          );
        }
        const saved = memory.commit({
          events: [],
          exchanges: [
            {
              id: key,
              characterId: IDS.character,
              category: "character-generation",
              input,
              result,
            },
          ],
        });
        return saved.ok ? result : saved;
      } finally {
        busy = false;
      }
    },
    async run(request) {
      if (busy)
        return failure("conflict", "Wait for the current operation to finish.");
      if (
        !request ||
        typeof request.requestId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(request.requestId)
      )
        return failure(
          "invalid-document",
          "A valid request identifier is required.",
        );
      const selected = load(request.characterId, request.memoryCharacterId);
      if (!selected.ok) return selected;
      busy = true;
      try {
        // Event IDs are global in the existing store. Namespace new characters;
        // retain the original Lumen IDs so existing requests/history still work.
        const requestId =
          (!request.memoryCharacterId ||
            request.memoryCharacterId === request.characterId) &&
          (!request.characterId || request.characterId === IDS.character)
            ? request.requestId
            : `c-${createHash("sha256")
                .update(
                  JSON.stringify(
                    request.memoryCharacterId &&
                      request.memoryCharacterId !== request.characterId
                      ? [
                          request.characterId ?? IDS.character,
                          request.memoryCharacterId,
                          request.requestId,
                        ]
                      : [request.characterId, request.requestId],
                  ),
                )
                .digest("hex")
                .slice(0, 60)}`;
        return await selected.value.run({ ...request, requestId });
      } finally {
        busy = false;
      }
    },
  };
}
