package com.voicetranscriber.callrecorder.escalation

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EscalationJsonTest {

    private val reasons = """
        [
          { "code": "wants_senior", "label": "Customer wants a senior", "hint": "They asked to speak to someone above me." },
          { "code": "price_approval", "label": "Price or discount approval", "hint": "The deal needs a price I can't give." },
          { "code": "other", "label": "Something else", "hint": "Say what in the note." }
        ]
    """.trimIndent()

    private fun config(block: String?): JSONObject {
        val o = JSONObject("""{ "recordingEnabled": true, "version": 4 }""")
        if (block != null) o.put("callEscalation", if (block == "null") JSONObject.NULL else JSONObject(block))
        return o
    }

    @Test
    fun `an absent block means the feature is off`() {
        assertNull(EscalationJson.parseConfig(config(null)))
    }

    @Test
    fun `a JSON null block means the feature is off`() {
        assertNull(EscalationJson.parseConfig(config("null")))
    }

    @Test
    fun `a null recipient is null, never the string null`() {
        val c = EscalationJson.parseConfig(config("""{ "recipientName": null, "reasons": $reasons, "noteMax": 500 }"""))
        assertNotNull(c)
        assertNull(c!!.recipientName)
        assertEquals(3, c.reasons.size)
        assertEquals("wants_senior", c.reasons[0].code)
        assertEquals("Customer wants a senior", c.reasons[0].label)
        assertEquals("They asked to speak to someone above me.", c.reasons[0].hint)
        assertEquals(500, c.noteMax)
    }

    @Test
    fun `a named recipient is kept`() {
        val c = EscalationJson.parseConfig(config("""{ "recipientName": "Priya", "reasons": $reasons, "noteMax": 300 }"""))!!
        assertEquals("Priya", c.recipientName)
        assertEquals(300, c.noteMax)
    }

    @Test
    fun `no usable reasons, or a malformed block, reads as off without throwing`() {
        assertNull(EscalationJson.parseConfig(config("""{ "recipientName": "Priya", "reasons": [], "noteMax": 500 }""")))
        assertNull(EscalationJson.parseConfig(config("""{ "recipientName": "Priya", "reasons": "nope" }""")))
        assertNull(EscalationJson.parseConfig(config("""{ "reasons": [ { "label": "no code" } ] }""")))
        // A missing or nonsense noteMax falls back to the server's default.
        val c = EscalationJson.parseConfig(config("""{ "reasons": $reasons, "noteMax": 0 }"""))!!
        assertEquals(EscalationConfig.DEFAULT_NOTE_MAX, c.noteMax)
    }

    @Test
    fun `the stored block re-parses the same`() {
        val raw = config("""{ "recipientName": "Priya", "reasons": $reasons, "noteMax": 500 }""")
            .getJSONObject(EscalationJson.CONFIG_KEY).toString()
        assertEquals(
            EscalationJson.parseConfig(config("""{ "recipientName": "Priya", "reasons": $reasons, "noteMax": 500 }""")),
            EscalationJson.parseBlock(JSONObject(raw)),
        )
    }

    private fun view(
        id: String, callId: String, status: String, createdAt: String,
        ack: String? = null, by: String? = null, answer: String? = null,
    ): JSONObject = JSONObject()
        .put("id", id).put("callId", callId).put("status", status)
        .put("reason", "wants_senior").put("reasonLabel", "Customer wants a senior")
        .put("note", JSONObject.NULL).put("assignedToName", JSONObject.NULL)
        .put("acknowledgedByName", ack ?: JSONObject.NULL)
        .put("resolvedByName", by ?: JSONObject.NULL)
        .put("resolutionNote", answer ?: JSONObject.NULL)
        .put("createdAt", createdAt).put("resolvedAt", JSONObject.NULL)

    @Test
    fun `a view's nulls stay null and its status maps to a row line`() {
        val open = EscalationJson.parseView(view("e1", "c1", "open", "2026-10-01T10:00:00.000Z"))!!
        assertNull(open.assignedToName)
        assertNull(open.note)
        assertTrue(open.isLive)
        assertEquals(EscalationView.RowStatus.Waiting(null), open.rowStatus())

        val acked = EscalationJson.parseView(view("e2", "c2", "acknowledged", "2026-10-01T10:00:00.000Z", ack = "Priya"))!!
        assertTrue(acked.isLive)
        assertEquals(EscalationView.RowStatus.PickedUp("Priya"), acked.rowStatus())

        val done = EscalationJson.parseView(
            view("e3", "c3", "resolved", "2026-10-01T10:00:00.000Z", by = "Priya", answer = "Called them back"),
        )!!
        assertFalse(done.isLive)
        assertEquals(EscalationView.RowStatus.Answered("Priya", "Called them back"), done.rowStatus())

        val withdrawn = EscalationJson.parseView(view("e4", "c4", "withdrawn", "2026-10-01T10:00:00.000Z"))!!
        assertNull(withdrawn.rowStatus())
        val unknown = EscalationJson.parseView(view("e5", "c5", "something_new", "2026-10-01T10:00:00.000Z"))!!
        assertNull(unknown.rowStatus())

        // No id, no call or no status: skipped, not half-parsed.
        assertNull(EscalationJson.parseView(JSONObject().put("id", "x").put("status", "open")))
    }

    @Test
    fun `one escalation per call - the live one, else the newest`() {
        val arr = JSONArray()
            .put(view("old", "c1", "resolved", "2026-09-20T10:00:00.000Z", by = "A"))
            .put(view("live", "c1", "open", "2026-09-25T10:00:00.000Z"))
            .put(view("a", "c2", "resolved", "2026-09-20T10:00:00.000Z", by = "A"))
            .put(view("b", "c2", "withdrawn", "2026-09-28T10:00:00.000Z"))
        val byCall = EscalationJson.latestPerCall(EscalationJson.parseViews(arr))
        assertEquals("live", byCall["c1"]!!.id)
        assertEquals("b", byCall["c2"]!!.id)
    }

    @Test
    fun `a view survives the round trip through the cache`() {
        val v = EscalationJson.parseView(
            view("e3", "c3", "resolved", "2026-10-01T10:00:00.000Z", by = "Priya", answer = "Done"),
        )!!
        assertEquals(v, EscalationJson.parseView(JSONObject(v.toJson().toString())))
    }
}
