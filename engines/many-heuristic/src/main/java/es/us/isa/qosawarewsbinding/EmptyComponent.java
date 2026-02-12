package es.us.isa.qosawarewsbinding;

import java.io.Serializable;

/**
 * A no-op structural component representing an "ELEMENT" node in the
 * composition.
 * It is used for branches that do nothing (e.g., "skip" branches).
 */
public class EmptyComponent implements StructuralComponent, Serializable {

    private String id;

    public EmptyComponent(String id) {
        this.id = id;
    }

    public String getId() {
        return id;
    }

    @Override
    public String toStructuralString(String prefix) {
        return prefix + "ELEMENT(" + id + ")";
    }

    @Override
    public boolean isEmpty() {
        return false;
    }
}
