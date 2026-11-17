package com.aimusic.studio.model.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;

public class PaginatedProjectsResponse {

    @JsonProperty("items")
    private List<ProjectSummary> items = new ArrayList<>();

    @JsonProperty("total")
    private int total;

    @JsonProperty("page")
    private int page;

    @JsonProperty("limit")
    private int limit;

    @JsonProperty("total_pages")
    private int totalPages;

    public PaginatedProjectsResponse() {}

    public PaginatedProjectsResponse(List<ProjectSummary> items, int total, int page, int limit, int totalPages) {
        this.items = items != null ? items : new ArrayList<>();
        this.total = total;
        this.page = page;
        this.limit = limit;
        this.totalPages = totalPages;
    }

    public List<ProjectSummary> getItems() { return items; }
    public void setItems(List<ProjectSummary> items) { this.items = items; }

    public int getTotal() { return total; }
    public void setTotal(int total) { this.total = total; }

    public int getPage() { return page; }
    public void setPage(int page) { this.page = page; }

    public int getLimit() { return limit; }
    public void setLimit(int limit) { this.limit = limit; }

    public int getTotalPages() { return totalPages; }
    public void setTotalPages(int totalPages) { this.totalPages = totalPages; }
}
