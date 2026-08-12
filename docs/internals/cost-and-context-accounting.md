# Cost and context accounting

Cost and context pressure are separate measurements. A parent turn, mission, packet, or lane owns the billable usage of work it launches, so its cost receipt includes child agents and every distinct retry session. Context pressure counts only tokens that entered the parent's own window. Child internals never increase the parent's context meter or trigger compaction; only the summary returned into the parent transcript can do that. Persist and deduplicate cost by runtime session key, including archived lane sessions, before rolling it up to the parent.
