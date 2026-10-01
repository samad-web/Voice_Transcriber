package com.voicetranscriber.callrecorder.ui

import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.appcompat.widget.PopupMenu
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.card.MaterialCardView
import com.voicetranscriber.callrecorder.R
import com.voicetranscriber.callrecorder.databinding.ItemRecordingBinding
import com.voicetranscriber.callrecorder.escalation.EscalationStore
import com.voicetranscriber.callrecorder.escalation.EscalationView
import com.voicetranscriber.callrecorder.recordings.SourceRegistry
import com.voicetranscriber.callrecorder.storage.RecordingEntity

class RecordingsAdapter(
    private val onPlayToggle: (RecordingEntity) -> Unit,
    private val onDelete: (RecordingEntity) -> Unit,
    private val onShare: (RecordingEntity) -> Unit,
    private val onEdit: (RecordingEntity) -> Unit,
    private val onEnterSelection: (RecordingEntity) -> Unit,
    private val onToggleSelect: (RecordingEntity) -> Unit,
    private val onEscalate: (RecordingEntity) -> Unit,
) : ListAdapter<RecordingEntity, RecordingsAdapter.VH>(DIFF) {

    private var playingId: Long? = null

    /** Call escalations (Build docs/38): the config + the latest escalation per server call id. */
    private var escalation = EscalationStore.State(null, emptyMap())

    /**
     * Rebinds only the rows whose escalation changed - a switched-off feature
     * arrives here as an empty map, so every row that showed a status loses it.
     * The menu reads [escalation] when it opens, so it needs no rebind.
     */
    fun setEscalationState(state: EscalationStore.State) {
        val old = escalation.byCall
        escalation = state
        val changed = (old.keys + state.byCall.keys).filterTo(HashSet()) { old[it] != state.byCall[it] }
        if (changed.isEmpty()) return
        currentList.forEachIndexed { pos, item ->
            if (item.remoteCallId != null && item.remoteCallId in changed) notifyItemChanged(pos, PAYLOAD_ESCALATION)
        }
    }

    // --- multi-select state ---
    private var selectionMode = false
    private val selectedIds = LinkedHashSet<Long>()

    fun setPlaying(id: Long?) {
        if (id == playingId) return
        val previous = playingId
        playingId = id
        listOf(previous, id).forEach { changed ->
            val pos = currentList.indexOfFirst { it.id == changed }
            if (pos != -1) notifyItemChanged(pos)
        }
    }

    /** Enter/leave multi-select mode; leaving clears the selection. */
    fun setSelectionMode(on: Boolean) {
        if (selectionMode == on) return
        selectionMode = on
        if (!on) selectedIds.clear()
        notifyDataSetChanged()
    }

    fun toggle(item: RecordingEntity) {
        if (!selectedIds.add(item.id)) selectedIds.remove(item.id)
        val pos = currentList.indexOfFirst { it.id == item.id }
        if (pos != -1) notifyItemChanged(pos)
    }

    fun selectAll() {
        selectedIds.clear()
        selectedIds.addAll(currentList.map { it.id })
        notifyDataSetChanged()
    }

    fun selectedCount(): Int = selectedIds.size

    fun selectedItems(): List<RecordingEntity> =
        currentList.filter { it.id in selectedIds }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val binding = ItemRecordingBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return VH(binding)
    }

    override fun onBindViewHolder(holder: VH, position: Int) =
        holder.bind(getItem(position), isPlaying = getItem(position).id == playingId)

    /** An escalation-only change touches just the status line - no full rebind, no flicker. */
    override fun onBindViewHolder(holder: VH, position: Int, payloads: MutableList<Any>) {
        if (payloads.isNotEmpty() && payloads.all { it == PAYLOAD_ESCALATION }) {
            holder.bindEscalation(getItem(position))
        } else {
            onBindViewHolder(holder, position)
        }
    }

    inner class VH(private val binding: ItemRecordingBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(item: RecordingEntity, isPlaying: Boolean) {
            val ctx = binding.root.context
            binding.title.text = item.callee ?: ctx.getString(R.string.unknown_caller)

            // Direction is conveyed by the avatar glyph, not text.
            binding.avatar.setImageResource(
                when (item.direction) {
                    "incoming" -> R.drawable.ic_call_received
                    "outgoing" -> R.drawable.ic_call_made
                    else -> R.drawable.ic_phone
                },
            )

            val sourceLabel = SourceRegistry.BUILT_IN.firstOrNull { it.id == item.sourceId }?.label
                ?: item.sourceId
            binding.subtitle.text = buildString {
                append(sourceLabel)
                append(" · ")
                append(DateUtils.getRelativeTimeSpanString(item.startedAt))
                append(" · ")
                append(durationText(item))
            }

            val extra = item.note ?: item.transcript
            binding.transcript.text = extra
            binding.transcript.visibility = if (extra.isNullOrBlank()) View.GONE else View.VISIBLE
            bindEscalation(item)

            binding.play.setImageResource(
                if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
            )

            val card = binding.root as MaterialCardView
            if (selectionMode) {
                // Selection mode: the whole row toggles; per-row actions are hidden.
                val selected = item.id in selectedIds
                card.isCheckable = true
                card.isChecked = selected
                card.strokeWidth =
                    if (selected) (2 * ctx.resources.displayMetrics.density).toInt() else 0
                binding.play.visibility = View.GONE
                binding.overflow.visibility = View.GONE
                card.setOnClickListener { onToggleSelect(item) }
                card.setOnLongClickListener { onToggleSelect(item); true }
            } else {
                card.isChecked = false
                card.strokeWidth = 0
                card.isCheckable = false
                binding.play.visibility = View.VISIBLE
                binding.overflow.visibility = View.VISIBLE
                binding.play.setOnClickListener { onPlayToggle(item) }
                binding.overflow.setOnClickListener { showMenu(it, item) }
                // Tap does nothing; long-press starts multi-select.
                card.setOnClickListener(null)
                card.isClickable = false
                card.setOnLongClickListener { onEnterSelection(item); true }
            }
        }

        /** "Escalated · waiting" / "Picked up by Priya" / "Answered by Priya: ..." - or nothing. */
        fun bindEscalation(item: RecordingEntity) {
            val ctx = binding.root.context
            val view = item.remoteCallId?.let { escalation.byCall[it] }
            val text = when (val s = view?.rowStatus()) {
                null -> null
                is EscalationView.RowStatus.Waiting ->
                    s.with?.let { ctx.getString(R.string.escalation_waiting_for, it) }
                        ?: ctx.getString(R.string.escalation_waiting)
                is EscalationView.RowStatus.PickedUp ->
                    s.by?.let { ctx.getString(R.string.escalation_picked_up_by, it) }
                        ?: ctx.getString(R.string.escalation_picked_up)
                is EscalationView.RowStatus.Answered -> {
                    val head = s.by?.let { ctx.getString(R.string.escalation_answered_by, it) }
                        ?: ctx.getString(R.string.escalation_answered)
                    val note = s.note?.replace(Regex("\\s+"), " ")?.trim()?.ifBlank { null }
                    if (note == null) {
                        head
                    } else {
                        val short = if (note.length > NOTE_PREVIEW_CHARS) note.take(NOTE_PREVIEW_CHARS).trimEnd() + "…" else note
                        ctx.getString(R.string.escalation_answered_note, head, short)
                    }
                }
            }
            binding.escalationStatus.text = text
            binding.escalationStatus.visibility = if (text == null) View.GONE else View.VISIBLE
        }

        private fun showMenu(anchor: View, item: RecordingEntity) {
            PopupMenu(anchor.context, anchor).apply {
                menuInflater.inflate(R.menu.menu_recording, menu)
                // Call escalations (Build docs/38): only while the server sends the
                // block, only for an uploaded call (the server knows it by
                // remoteCallId), and only when that call has no live escalation.
                val config = escalation.config
                val canEscalate = config != null && item.remoteCallId != null && !escalation.isLive(item.remoteCallId)
                menu.findItem(R.id.action_escalate)?.let { mi ->
                    mi.isVisible = canEscalate
                    if (canEscalate) {
                        mi.title = config?.recipientName
                            ?.let { anchor.context.getString(R.string.escalate_to, it) }
                            ?: anchor.context.getString(R.string.escalate_to_manager)
                    }
                }
                setOnMenuItemClickListener { mi ->
                    when (mi.itemId) {
                        R.id.action_edit -> onEdit(item)
                        R.id.action_share -> onShare(item)
                        R.id.action_escalate -> onEscalate(item)
                        R.id.action_delete -> onDelete(item)
                    }
                    true
                }
                show()
            }
        }

        private fun durationText(item: RecordingEntity): String {
            val end = item.endedAt ?: return itemView.context.getString(R.string.recording_in_progress)
            val secs = ((end - item.startedAt) / 1000).coerceAtLeast(0)
            return "%d:%02d".format(secs / 60, secs % 60)
        }
    }

    private companion object {
        const val PAYLOAD_ESCALATION = "escalation"

        /** How much of a manager's answer fits on the row; the line ellipsizes after two lines anyway. */
        const val NOTE_PREVIEW_CHARS = 120

        val DIFF = object : DiffUtil.ItemCallback<RecordingEntity>() {
            override fun areItemsTheSame(a: RecordingEntity, b: RecordingEntity) = a.id == b.id
            override fun areContentsTheSame(a: RecordingEntity, b: RecordingEntity) = a == b
        }
    }
}
