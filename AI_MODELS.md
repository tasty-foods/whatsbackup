# Choosing OpenAI models in WhatsBackUp

1. Open **Settings → AI & search** and scroll to **Service**.
2. Choose **OpenAI** as the provider and save your OpenAI API key if one is not already saved.
3. Use **Models available to your OpenAI key** to search the live catalogue. **Refresh models** requests a fresh list from OpenAI.
4. Select a model and click **Test selected model**. A successful text and structured-output test saves the choice. A failed test keeps the previous saved model.

The model catalogue comes from OpenAI's authenticated Models API, rather than a fixed list bundled with this app. It is cached in memory for 15 minutes per credential. No API key is returned to the browser or written into the model catalogue.

## Which models can be selected?

Text/chat models and models whose capabilities are not yet known can be tested for archive work. Fine-tuned IDs can also be entered under **Enter an exact model ID**. The connection test checks ordinary text, structured replies, and a generated red test image. It does not send your saved files or messages.

Image generation, transcription, audio/realtime, embeddings, moderation, and video-generation models appear with an explanation of their separate purpose. They cannot replace the archive's text/chat model. A model that OpenAI declares already retired remains visible with its retirement date and cannot be selected.

An API listing does not prove that a model supports every feature or that the account has permission or credit to run it. The test shows what worked. A text-only model can process text while a suitable provider in the fallback chain handles image work.

## Compatibility options

Leave **API** on **Automatic** unless you need a particular model's documented endpoint. Modern models use OpenAI's Responses API; legacy models can use Chat Completions. The adapter changes endpoint or output format only when OpenAI explicitly rejects an unsupported option before generating a response.

**Reasoning effort** defaults to an automatic setting appropriate to known model families. The model must support any explicitly selected effort. Higher reasoning settings can take longer and use more paid tokens. A failed test does not silently save that choice.

Changing the primary model does not change the speech-transcription or search-embedding models. Those are separate provider capabilities.

## Saved settings and cost

Your API key is encrypted in the desktop app's Windows credential storage. The chosen model, provider and compatibility options are ordinary settings. Existing fallbacks, pause state, AI mode and monthly budget are preserved when choosing a model.

Known model prices are used for estimates and spending records. For an unlisted price, the app reports that the price is unknown and counts usage conservatively against its budget. The budget is an application spending control, not a replacement for OpenAI project limits. Paid reasoning tokens and incomplete answers are included when OpenAI reports usage; a paid incomplete or refused answer is not automatically replayed on a different provider.

References: [OpenAI model list](https://developers.openai.com/api/reference/resources/models/methods/list), [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses).
